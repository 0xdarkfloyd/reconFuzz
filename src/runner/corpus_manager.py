"""Seed corpus storage, metadata tracking, and deduplication."""

from __future__ import annotations

import json
import shutil
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast

from .d8_wrapper import FUZZILLI_SHM_SIZE


@dataclass
class Seed:
    """A seed in the fuzzing corpus."""

    id: str
    source: str
    flags: list[str]
    crash_class: str
    stack_hash: str
    coverage_hash: str | None = None
    energy: int = 1
    found_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    # In-memory only: raw Fuzzilli edge bitmap for coverage-gain admission.
    # Never persisted to meta.json (hundreds of KB).
    coverage_bitmap: bytes | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "flags": self.flags,
            "crash_class": self.crash_class,
            "stack_hash": self.stack_hash,
            "coverage_hash": self.coverage_hash,
            "energy": self.energy,
            "found_at": self.found_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any], source: str) -> Seed:
        return cls(
            id=cast(str, data["id"]),
            source=source,
            flags=cast(list[str], data["flags"]),
            crash_class=cast(str, data["crash_class"]),
            stack_hash=cast(str, data["stack_hash"]),
            coverage_hash=cast(str | None, data.get("coverage_hash")),
            energy=cast(int, data.get("energy", 1)),
            found_at=cast(str, data.get("found_at", datetime.now(timezone.utc).isoformat())),
        )


class CorpusManager:
    """Manage the on-disk corpus and crash directories."""

    UNION_PATH = "coverage_union.bin"
    GAIN_ENERGY_FLOOR = 10

    def __init__(
        self,
        corpus_dir: Path,
        crashes_dir: Path,
        admission: str = "hash",
        manage_union: bool = True,
    ) -> None:
        if admission not in ("hash", "gain"):
            raise ValueError(f"unknown admission policy: {admission}")
        self.corpus_dir = corpus_dir
        self.crashes_dir = crashes_dir
        # "gain": admit a seed only when its edge bitmap contains at least one
        #         edge no previously evaluated testcase hit (global-union
        #         novelty, AFL-style). "hash": admit on unseen exact coverage
        #         hash. Gain mode falls back to hash/stack keys for seeds
        #         without a bitmap.
        self.admission = admission
        # When False (REPRL mode), gain admission runs in the workers against a
        # shared CoverageUnion, which also owns the union file; this manager
        # then only does cheap hash dedup and must not touch the file.
        self.manage_union = manage_union
        self.corpus_dir.mkdir(parents=True, exist_ok=True)
        self.crashes_dir.mkdir(parents=True, exist_ok=True)
        self._seen_seed_keys: set[str] = set()
        self._seen_crash_keys: set[str] = set()
        self._seen_coverage: set[str] = set()
        self._coverage_union = bytearray(FUZZILLI_SHM_SIZE - 4)
        self._coverage_union_dirty = False
        self._coverage_union_last_write = 0.0
        if manage_union:
            union_file = self.corpus_dir / self.UNION_PATH
            if union_file.exists():
                try:
                    saved = union_file.read_bytes()
                    self._coverage_union[: len(saved)] = saved[: len(self._coverage_union)]
                except OSError:
                    pass
        # Preload dedup keys from previously saved seeds/crashes so dedup
        # persists across runs instead of only within one process.
        for directory, crash_directory in (
            (self.corpus_dir, False),
            (self.crashes_dir, True),
        ):
            for meta_path in directory.glob("*/meta.json"):
                data = self._read_metadata(meta_path)
                if data is None:
                    continue
                stack_hash = data.get("stack_hash")
                crash_class = data.get("crash_class", "")
                if isinstance(stack_hash, str) and isinstance(crash_class, str):
                    key = self._dedup_key(crash_class, stack_hash)
                    (self._seen_crash_keys if crash_directory else self._seen_seed_keys).add(key)
                coverage_hash = data.get("coverage_hash")
                if isinstance(coverage_hash, str) and coverage_hash and not crash_directory:
                    self._seen_coverage.add(coverage_hash)

    @staticmethod
    def _read_metadata(meta_path: Path) -> dict[str, Any] | None:
        """Read object-shaped JSON metadata, ignoring incomplete entries."""
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeError):
            return None
        return data if isinstance(data, dict) else None

    @staticmethod
    def _dedup_key(crash_class: str, stack_hash: str) -> str:
        # Include the class: different crash classes can legitimately share a
        # stack hash (most notably the empty hash when output has no frames),
        # and class-blind dedup was silently dropping real crashes whose hash
        # collided with a previously seen TIMEOUT.
        return f"{crash_class}:{stack_hash}"

    def add_seed(self, seed: Seed) -> bool:
        """Add a seed when it introduces coverage or a new legacy signature.

        Coverage is the admission key for normal executions. In "gain" mode a
        seed carrying an edge bitmap is admitted only when it hits at least
        one globally unseen edge, and the global union is updated; the
        retained seed then becomes available for scheduler replay/mutation.
        The hash and class/stack fallbacks keep manually-created and imported
        seeds deduplicated when a runner cannot provide a bitmap.
        """
        gained_bitmap: bytes | None = None
        coverage_hash: str | None = None
        seed_key: str | None = None
        if self.admission == "gain" and seed.coverage_bitmap is not None:
            if not self._has_coverage_gain(seed.coverage_bitmap):
                return False
            gained_bitmap = seed.coverage_bitmap
        elif seed.coverage_hash:
            if seed.coverage_hash in self._seen_coverage:
                return False
            coverage_hash = seed.coverage_hash
        else:
            seed_key = self._dedup_key(seed.crash_class, seed.stack_hash)
            if seed_key in self._seen_seed_keys:
                return False

        seed_dir = self._unique_dir(self.corpus_dir, seed.id)
        seed_dir.mkdir(parents=True, exist_ok=True)
        (seed_dir / "testcase.js").write_text(seed.source, encoding="utf-8")
        if gained_bitmap is not None:
            new_edge_count = self._count_new_edges(gained_bitmap)
            seed.energy = self.GAIN_ENERGY_FLOOR + new_edge_count
        metadata = seed.to_dict()
        metadata["id"] = seed_dir.name
        (seed_dir / "meta.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

        if gained_bitmap is not None:
            self._merge_coverage(gained_bitmap)
        elif coverage_hash is not None:
            self._seen_coverage.add(coverage_hash)
        elif seed_key is not None:
            self._seen_seed_keys.add(seed_key)
        return True

    def _has_coverage_gain(self, bitmap: bytes) -> bool:
        """Return whether a bitmap contains an edge absent from the union."""
        union = self._coverage_union
        if len(bitmap) > len(union):
            raise ValueError("coverage bitmap exceeds the configured union size")
        for index, byte in enumerate(bitmap):
            if byte & ~union[index]:
                return True
        return False

    def _count_new_edges(self, bitmap: bytes) -> int:
        """Count bitmap edges that are not already present in the union."""
        union = self._coverage_union
        if len(bitmap) > len(union):
            raise ValueError("coverage bitmap exceeds the configured union size")
        return sum((byte & ~union[index]).bit_count() for index, byte in enumerate(bitmap))

    def _merge_coverage(self, bitmap: bytes) -> None:
        """Merge a known-novel bitmap into the union and schedule persistence."""
        union = self._coverage_union
        for index, byte in enumerate(bitmap):
            union[index] |= byte
        self._coverage_union_dirty = True
        self._persist_coverage_union()

    def _persist_coverage_union(self, force: bool = False) -> None:
        """Write the union bitmap so gain dedup survives restarts.

        Throttled: admissions can arrive in bursts early in a campaign, and
        rewriting ~1MB per seed is wasteful. Losing a few seconds of union
        state on a crash only re-admits a handful of duplicate seeds.
        """
        if not self.manage_union:
            return  # REPRL mode: CoverageUnion owns the union file.
        now = time.monotonic()
        if not force and now - self._coverage_union_last_write < 5.0:
            return
        self._coverage_union_last_write = now
        try:
            (self.corpus_dir / self.UNION_PATH).write_bytes(bytes(self._coverage_union))
            self._coverage_union_dirty = False
        except OSError:
            pass

    def add_crash(self, seed: Seed) -> bool:
        """Persist a crash if it is new by class + stack_hash."""
        key = self._dedup_key(seed.crash_class, seed.stack_hash)
        if key in self._seen_crash_keys:
            return False

        crash_dir = self._unique_dir(self.crashes_dir, seed.id)
        crash_dir.mkdir(parents=True, exist_ok=True)
        (crash_dir / "testcase.js").write_text(seed.source, encoding="utf-8")
        metadata = seed.to_dict()
        metadata["id"] = crash_dir.name
        (crash_dir / "meta.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        self._seen_crash_keys.add(key)
        return True

    @staticmethod
    def _unique_dir(directory: Path, seed_id: str) -> Path:
        """Choose a persistence path without overwriting another finding."""
        candidate = directory / seed_id
        if not candidate.exists():
            return candidate
        suffix = 1
        while True:
            candidate = directory / f"{seed_id}_{suffix}"
            if not candidate.exists():
                return candidate
            suffix += 1

    def iter_seeds(self) -> Iterable[Seed]:
        """Yield all seeds currently stored in the corpus."""
        for seed_dir in sorted(self.corpus_dir.iterdir()):
            if not seed_dir.is_dir():
                continue
            meta_path = seed_dir / "meta.json"
            testcase_path = seed_dir / "testcase.js"
            if not meta_path.exists() or not testcase_path.exists():
                continue
            data = self._read_metadata(meta_path)
            if data is None:
                continue
            try:
                source = testcase_path.read_text(encoding="utf-8")
                data["id"] = seed_dir.name
                yield Seed.from_dict(data, source)
            except (OSError, UnicodeError, KeyError, TypeError):
                continue

    def iter_seed_metadata(self) -> Iterable[Seed]:
        """Yield lightweight seed records for scheduling without reading JS."""
        for seed_dir in sorted(self.corpus_dir.iterdir()):
            if not seed_dir.is_dir():
                continue
            meta_path = seed_dir / "meta.json"
            testcase_path = seed_dir / "testcase.js"
            if not meta_path.exists() or not testcase_path.exists():
                continue
            data = self._read_metadata(meta_path)
            if data is None:
                continue
            try:
                data["id"] = seed_dir.name
                yield Seed.from_dict(data, "")
            except (KeyError, TypeError):
                continue

    def import_directory(self, source_dir: Path) -> int:
        """Import an external testcase directory tree (e.g., big_sleep)."""
        count = 0
        for issue_dir in source_dir.iterdir():
            if not issue_dir.is_dir():
                continue
            meta_path = issue_dir / "meta.json"
            for testcase in issue_dir.glob("testcase_*.js"):
                source = testcase.read_text(encoding="utf-8", errors="replace")
                flags: list[str] = []
                if source.startswith("// Flags:"):
                    flags = source.splitlines()[0].replace("// Flags:", "").strip().split()

                data = self._read_metadata(meta_path) or {}

                seed = Seed(
                    id=str(issue_dir.name),
                    source=source,
                    flags=flags,
                    crash_class=data.get("title", "imported"),
                    stack_hash=f"imported-{issue_dir.name}-{testcase.name}",
                )
                if self.add_seed(seed):
                    count += 1
        return count

    def clear(self) -> None:
        """Delete all corpus and crash entries. Useful for testing."""
        shutil.rmtree(self.corpus_dir, ignore_errors=True)
        shutil.rmtree(self.crashes_dir, ignore_errors=True)
        self.corpus_dir.mkdir(parents=True, exist_ok=True)
        self.crashes_dir.mkdir(parents=True, exist_ok=True)
        self._seen_seed_keys.clear()
        self._seen_crash_keys.clear()
        self._seen_coverage.clear()
        self._coverage_union = bytearray(FUZZILLI_SHM_SIZE - 4)
        self._coverage_union_dirty = False
