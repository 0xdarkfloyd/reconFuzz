"""Wrapper around the V8 developer shell (d8)."""

from __future__ import annotations

import subprocess
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import psutil


@dataclass(frozen=True)
class D8Result:
    """Result of running a single testcase under d8."""

    returncode: int
    stdout: str
    stderr: str
    timed_out: bool
    duration_ms: float
    coverage_hash: str | None


class D8Wrapper:
    """Execute JavaScript testcases in an isolated d8 process."""

    def __init__(
        self,
        d8_path: Path | str,
        timeout_seconds: float = 10.0,
        default_flags: Sequence[str] | None = None,
    ) -> None:
        self.d8_path = Path(d8_path)
        self.timeout_seconds = timeout_seconds
        # Add --trace-pc for coverage tracking
        self.default_flags = list(default_flags or ["--allow-natives-syntax", "--trace-pc"])

        if not self.d8_path.exists():
            raise FileNotFoundError(f"d8 not found at {self.d8_path}")

    def _extract_coverage(self, stdout: str) -> str | None:
        """Extract a simplified coverage hash from V8's --trace-pc output."""
        # --trace-pc output is extremely verbose, usually looks like:
        # 0x7fa2b6e14a1f
        # 0x7fa2b6e14a27
        # We can extract just the addresses to compute a distinct trace profile.
        import hashlib
        pcs = []
        for line in stdout.splitlines():
            if line.startswith("0x"):
                pcs.append(line)
        
        if pcs:
            # Create a short hash of the PC trace as a coverage identifier
            return hashlib.md5("".join(pcs).encode()).hexdigest()[:16]
        return None

    def run(
        self,
        source: str,
        extra_flags: Sequence[str] | None = None,
    ) -> D8Result:
        """Run a JS source string under d8 and return captured output."""
        flags = list(self.default_flags)
        if extra_flags:
            flags.extend(extra_flags)

        import time
        start_time = time.perf_counter()

        with tempfile.NamedTemporaryFile(mode="w", suffix=".js", delete=False) as tmp:
            tmp.write(source)
            tmp_path = Path(tmp.name)

        try:
            cmd = [str(self.d8_path), *flags, str(tmp_path)]
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
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

            cov_hash = self._extract_coverage(stdout) if not timed_out else None

            return D8Result(
                returncode=proc.returncode,
                stdout=stdout,
                stderr=stderr,
                timed_out=timed_out,
                duration_ms=(time.perf_counter() - start_time) * 1000.0,
                coverage_hash=cov_hash,
            )
        finally:
            tmp_path.unlink(missing_ok=True)
