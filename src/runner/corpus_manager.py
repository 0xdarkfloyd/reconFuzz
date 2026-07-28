"""Seed corpus storage, metadata tracking, and deduplication."""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast


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

    def __init__(self, corpus_dir: Path, crashes_dir: Path) -> None:
        self.corpus_dir = corpus_dir
        self.crashes_dir = crashes_dir
        self.corpus_dir.mkdir(parents=True, exist_ok=True)
        self.crashes_dir.mkdir(parents=True, exist_ok=True)
        self._seen_hashes: set[str] = set()

    def add_seed(self, seed: Seed) -> bool:
        """Add a seed to the corpus if it is new by stack_hash."""
        if seed.stack_hash in self._seen_hashes:
            return False
        self._seen_hashes.add(seed.stack_hash)

        seed_dir = self.corpus_dir / seed.id
        seed_dir.mkdir(parents=True, exist_ok=True)
        (seed_dir / "testcase.js").write_text(seed.source, encoding="utf-8")
        (seed_dir / "meta.json").write_text(json.dumps(seed.to_dict(), indent=2), encoding="utf-8")
        return True

    def add_crash(self, seed: Seed) -> bool:
        """Persist a crash if it is new by stack_hash."""
        if seed.stack_hash in self._seen_hashes:
            return False
        self._seen_hashes.add(seed.stack_hash)

        crash_dir = self.crashes_dir / seed.id
        crash_dir.mkdir(parents=True, exist_ok=True)
        (crash_dir / "testcase.js").write_text(seed.source, encoding="utf-8")
        (crash_dir / "meta.json").write_text(json.dumps(seed.to_dict(), indent=2), encoding="utf-8")
        return True

    def iter_seeds(self) -> Iterable[Seed]:
        """Yield all seeds currently stored in the corpus."""
        for seed_dir in sorted(self.corpus_dir.iterdir()):
            if not seed_dir.is_dir():
                continue
            meta_path = seed_dir / "meta.json"
            testcase_path = seed_dir / "testcase.js"
            if not meta_path.exists() or not testcase_path.exists():
                continue
            source = testcase_path.read_text(encoding="utf-8")
            data = json.loads(meta_path.read_text(encoding="utf-8"))
            yield Seed.from_dict(data, source)

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

                data = {}
                if meta_path.exists():
                    try:
                        data = json.loads(meta_path.read_text(encoding="utf-8"))
                    except json.JSONDecodeError:
                        pass

                seed = Seed(
                    id=str(issue_dir.name),
                    source=source,
                    flags=flags,
                    crash_class=data.get("title", "imported"),
                    stack_hash=f"imported-{issue_dir.name}",
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
        self._seen_hashes.clear()
