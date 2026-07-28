"""High-level API tying generator, runner, detector, and corpus together."""

from __future__ import annotations

import hashlib
import time

from .corpus_manager import CorpusManager, Seed
from .d8_wrapper import D8Wrapper
from .detector import Detection, Detector


class Harness:
    """Run generated/mutated programs and decide what to keep."""

    def __init__(
        self,
        d8: D8Wrapper,
        detector: Detector,
        corpus: CorpusManager,
    ) -> None:
        self.d8 = d8
        self.detector = detector
        self.corpus = corpus

    def run_source(
        self,
        source: str,
        flags: list[str] | None = None,
        seed_id: str | None = None,
    ) -> tuple[Detection, Seed]:
        """Execute a JS source string and classify the result."""
        flags = flags or []
        result = self.d8.run(source, extra_flags=flags)
        detection = self.detector.detect(result)

        seed_id = seed_id or self._make_id(source)
        seed = Seed(
            id=seed_id,
            source=source,
            flags=flags,
            crash_class=detection.crash_class.name,
            stack_hash=detection.stack_hash,
        )
        return detection, seed

    def evaluate(
        self,
        source: str,
        flags: list[str] | None = None,
        seed_id: str | None = None,
    ) -> Detection:
        """Run, detect, and persist interesting results."""
        detection, seed = self.run_source(source, flags, seed_id)

        if detection.is_crash:
            self.corpus.add_crash(seed)
        else:
            self.corpus.add_seed(seed)

        return detection

    @staticmethod
    def _make_id(source: str) -> str:
        digest = hashlib.sha256(source.encode("utf-8")).hexdigest()
        timestamp = int(time.time() * 1000)
        return f"{timestamp}_{digest[:12]}"
