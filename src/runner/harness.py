"""High-level API tying generator, runner, detector, and corpus together."""

from __future__ import annotations

import hashlib
import shlex
import subprocess

from .corpus_manager import CorpusManager, Seed
from .d8_wrapper import D8Wrapper
from .detector import CrashClass, Detection, Detector
from .reprl import ReprlRunner


class Harness:
    """Run generated/mutated programs and decide what to keep."""

    def __init__(
        self,
        d8: D8Wrapper | ReprlRunner,
        detector: Detector,
        corpus: CorpusManager | None = None,
    ) -> None:
        self.d8 = d8
        self.detector = detector
        self.corpus = corpus

    def run_source(
        self,
        source: str,
        flags: list[str] | str | None = None,
        seed_id: str | None = None,
    ) -> tuple[Detection, Seed]:
        """Execute a JS source string and classify the result."""
        if not isinstance(source, str):
            raise TypeError("source must be a str")

        # Copy flags so caller mutation cannot corrupt the persisted seed.
        if flags is None:
            normalized_flags: list[str] = []
        elif isinstance(flags, str):
            normalized_flags = shlex.split(flags)
        elif isinstance(flags, list):
            normalized_flags = list(flags)
        else:
            raise TypeError("flags must be a str, list[str], or None")

        coverage_hash: str | None = None
        coverage_bitmap: bytes | None = None
        try:
            result = self.d8.run(source, extra_flags=normalized_flags)
        except subprocess.TimeoutExpired as exc:
            detection = Detection(
                is_crash=False,
                crash_class=CrashClass.TIMEOUT,
                title=f"{type(exc).__name__}: {exc}",
                stack_hash="timeout",
                raw=repr(exc)[:256],
            )
        except OSError as exc:
            detection = Detection(
                is_crash=False,
                crash_class=CrashClass.UNKNOWN,
                title=f"{type(exc).__name__}: {exc}",
                stack_hash=f"tool-error:{type(exc).__name__}",
                raw=repr(exc)[:256],
            )
        else:
            detection = self.detector.detect(result)
            coverage_hash = getattr(result, "coverage_hash", None)
            coverage_bitmap = getattr(result, "coverage_bitmap", None)

        # Record the flags that ACTUALLY ran. Under REPRL the per-testcase flags
        # are ignored (the runner uses a fixed startup set), so record that set;
        # the one-shot wrapper honors per-testcase flags, so record those.
        if getattr(self.d8, "honors_per_testcase_flags", True):
            recorded_flags = normalized_flags
        else:
            recorded_flags = list(self.d8.default_flags)

        seed_id = seed_id or self._make_id(source)
        seed = Seed(
            id=seed_id,
            source=source,
            flags=recorded_flags,
            crash_class=detection.crash_class.name,
            stack_hash=detection.stack_hash,
            coverage_hash=coverage_hash,
            coverage_bitmap=coverage_bitmap,
        )
        return detection, seed

    def evaluate(
        self,
        source: str,
        flags: list[str] | None = None,
        seed_id: str | None = None,
    ) -> Detection:
        """Run and detect, persisting to a corpus when configured.

        With no corpus, nothing is persisted; crashes use ``add_crash`` and
        all other detections use ``add_seed``.
        """
        detection, seed = self.run_source(source, flags, seed_id)

        if self.corpus is None:
            return detection
        if detection.is_crash:
            self.corpus.add_crash(seed)
        else:
            self.corpus.add_seed(seed)

        return detection

    @staticmethod
    def _make_id(source: str) -> str:
        """Return a deterministic 16-hex-character sha256-prefix id.

        ``CorpusManager._unique_dir`` suffixes collisions, so this width is safe.
        """
        digest = hashlib.sha256(source.encode("utf-8")).hexdigest()
        return f"seed_{digest[:16]}"
