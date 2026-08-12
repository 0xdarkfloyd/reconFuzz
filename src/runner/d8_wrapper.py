"""Wrapper around the V8 developer shell (d8)."""

from __future__ import annotations

import hashlib
import os
import re
import struct
import subprocess
import tempfile
import time
from collections.abc import Sequence
from dataclasses import dataclass
from multiprocessing import shared_memory
from pathlib import Path
from typing import Any, cast

import psutil

# Fuzzilli-instrumented d8 builds (v8_fuzzilli=true) export edge coverage
# through a POSIX shared-memory bitmap named by the SHM_ID environment
# variable. The layout is fixed by src/fuzzilli/cov.cc in the V8 tree:
#   uint32 num_edges, followed by one bit per edge.
# Keep this in sync with ``SHM_SIZE`` in V8's src/fuzzilli/cov.cc. The first
# four bytes hold the edge count, followed by one bit per edge.
FUZZILLI_SHM_SIZE = 0x200000


def _open_shared_memory(
    *,
    name: str | None = None,
    create: bool = False,
    size: int = 0,
) -> shared_memory.SharedMemory:
    """Open shared memory without requiring Python 3.13's ``track`` flag.

    ``track=False`` prevents forked workers from racing the parent-owned
    segment's resource-tracker lifecycle, but the keyword was added after the
    Python 3.10 baseline. Retry without it on older interpreters.
    """
    kwargs: dict[str, object] = {"create": create, "size": size}
    if name is not None:
        kwargs["name"] = name
    constructor: Any = shared_memory.SharedMemory
    try:
        return cast(shared_memory.SharedMemory, constructor(**kwargs, track=False))
    except TypeError as error:
        if "track" not in str(error):
            raise
        return cast(shared_memory.SharedMemory, constructor(**kwargs))


@dataclass(frozen=True)
class D8Result:
    """Result of running a single testcase under d8."""

    returncode: int
    stdout: str
    stderr: str
    timed_out: bool
    duration_ms: float
    coverage_hash: str | None = None
    edge_count: int | None = None
    # Raw Fuzzilli edge bitmap (used portion only) when shmem coverage is
    # active. Enables true coverage-gain corpus admission downstream; kept
    # out of logs/metadata because of its size (~hundreds of KB).
    coverage_bitmap: bytes | None = None


class D8Wrapper:
    """Execute JavaScript testcases in an isolated d8 process."""

    # Each testcase runs in its own d8 process, so per-testcase flags ARE honored.
    honors_per_testcase_flags = True

    def __init__(
        self,
        d8_path: Path | str,
        timeout_seconds: float = 10.0,
        default_flags: Sequence[str] | None = None,
        coverage_flags: Sequence[str] | None = None,
        shmem_coverage: bool = False,
    ) -> None:
        self.d8_path = Path(d8_path)
        self.timeout_seconds = timeout_seconds
        self.default_flags = list(
            default_flags if default_flags is not None else ["--allow-natives-syntax"]
        )
        self.coverage_flags = list(coverage_flags if coverage_flags is not None else [])
        # When True, the binary is a Fuzzilli build and real native edge
        # coverage is collected from its shared-memory bitmap instead of
        # parsing textual coverage output.
        self.shmem_coverage = shmem_coverage

        if not self.d8_path.exists():
            raise FileNotFoundError(f"d8 not found at {self.d8_path}")

    @staticmethod
    def probe_shmem_coverage(d8_path: Path | str, timeout_seconds: float = 30.0) -> bool:
        """Return True when the d8 binary has Fuzzilli edge instrumentation.

        Instrumented builds announce their edge region on every startup,
        even without SHM_ID set, so one trivial execution is enough.
        """
        try:
            proc = subprocess.run(
                [str(d8_path), "-e", "1"],
                capture_output=True,
                text=True,
                errors="replace",
                timeout=timeout_seconds,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        return "[COV] edge counters initialized" in (proc.stdout + proc.stderr)

    def _extract_coverage(self, output: str) -> str | None:
        """Extract a coverage hash from native coverage/trace output.

        Fuzzilli-instrumented d8 builds print edge PCs, while some developer
        builds expose block counters or LCOV records instead. Keep the parser
        deliberately format-tolerant so either build can feed the same corpus
        logic. Source text is intentionally not a fallback: a source hash is
        an identity hash, not execution feedback.
        """
        tokens: list[str] = []
        for line in output.splitlines():
            stripped = line.strip()
            # d8's --lcov output contains stable execution counts but also an
            # SF path pointing at the per-run temporary source file. Exclude
            # SF so the random path cannot perturb an otherwise identical
            # coverage signature.
            if stripped.startswith(("DA:", "FNDA:")):
                tokens.append(stripped)
                continue
            if re.fullmatch(r"0x[0-9a-fA-F]+", stripped):
                tokens.append(stripped.lower())
                continue
            # Common sanitizer-coverage and V8 block-coverage forms, for
            # example ``edge=123 count=4`` or ``block 12: 1``.
            if re.search(r"(?:edge|block|counter|pc)[ _:=]+", stripped, re.IGNORECASE):
                tokens.append(stripped)

        if tokens:
            return hashlib.sha256("\n".join(tokens).encode()).hexdigest()[:16]
        return None

    def run(
        self,
        source: str,
        extra_flags: Sequence[str] | None = None,
    ) -> D8Result:
        """Run a JS source string under d8 and return captured output."""
        flags = list(self.default_flags)
        for flag in self.coverage_flags:
            if flag not in flags:
                flags.append(flag)
        if extra_flags:
            flags.extend(extra_flags)

        start_time = time.perf_counter()

        with tempfile.NamedTemporaryFile(mode="w", suffix=".js", delete=False) as tmp:
            tmp.write(source)
            tmp_path = Path(tmp.name)

        coverage_path: Path | None = None
        if (
            self.coverage_flags
            and not self.shmem_coverage
            and not any(flag.startswith("--lcov=") for flag in flags)
        ):
            with tempfile.NamedTemporaryFile(mode="w", suffix=".lcov", delete=False) as coverage_tmp:
                coverage_path = Path(coverage_tmp.name)

        # Fresh zero-filled bitmap per run. track=False keeps the segment out
        # of the multiprocessing resource tracker, which fork workers would
        # otherwise fight over; close()+unlink() in the finally below is the
        # whole lifecycle.
        shmem: shared_memory.SharedMemory | None = None
        env: dict[str, str] | None = None
        if self.shmem_coverage:
            shmem = _open_shared_memory(create=True, size=FUZZILLI_SHM_SIZE)
            env = dict(os.environ)
            env["SHM_ID"] = "/" + shmem.name

        try:
            if coverage_path is not None:
                flags.append(f"--lcov={coverage_path}")
            cmd = [str(self.d8_path), *flags, str(tmp_path)]
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                env=env,
            )

            try:
                stdout, stderr = proc.communicate(timeout=self.timeout_seconds)
                timed_out = False
            except subprocess.TimeoutExpired:
                parent = psutil.Process(proc.pid)
                for child in parent.children(recursive=True):
                    child.kill()
                parent.kill()
                stdout, stderr = proc.communicate()
                timed_out = True

            coverage_output = stdout + "\n" + stderr
            if coverage_path is not None:
                try:
                    coverage_output += "\n" + coverage_path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    pass

            cov_hash = None
            edge_count: int | None = None
            coverage_bitmap: bytes | None = None
            if not timed_out:
                if shmem is not None:
                    cov_hash, edge_count, coverage_bitmap = self._read_shmem_bitmap(shmem)
                else:
                    cov_hash = self._extract_coverage(coverage_output)

            return D8Result(
                returncode=proc.returncode,
                stdout=stdout,
                stderr=stderr,
                timed_out=timed_out,
                duration_ms=(time.perf_counter() - start_time) * 1000.0,
                coverage_hash=cov_hash,
                edge_count=edge_count,
                coverage_bitmap=coverage_bitmap,
            )
        finally:
            tmp_path.unlink(missing_ok=True)
            if coverage_path is not None:
                coverage_path.unlink(missing_ok=True)
            if shmem is not None:
                shmem.close()
                shmem.unlink()

    @staticmethod
    def _read_shmem_bitmap(
        shmem: shared_memory.SharedMemory,
    ) -> tuple[str | None, int | None, bytes | None]:
        """Read the Fuzzilli edge bitmap written by d8 into shared memory.

        Layout (src/fuzzilli/cov.cc): a little-endian uint32 num_edges
        header, then one bit per edge. Returns (None, None, None) when the
        child never initialized coverage (e.g. it crashed before startup
        finished), so callers can tell "no coverage channel" apart from
        "empty coverage".
        """
        buf = shmem.buf
        if buf is None:
            return None, None, None
        header = bytes(buf[:4])
        (num_edges,) = struct.unpack("<I", header)
        if num_edges == 0 or num_edges > (FUZZILLI_SHM_SIZE - 4) * 8:
            return None, None, None
        used = num_edges // 8 + 1
        bitmap = bytes(buf[4 : 4 + used])
        digest = hashlib.sha256(bitmap).hexdigest()[:16]
        edge_count = sum(byte.bit_count() for byte in bitmap)
        return digest, edge_count, bitmap
