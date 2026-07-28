"""Reproduce a single testcase under d8 and print detection results."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow importing the runner package without installation.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.runner import CorpusManager, D8Wrapper, Detector, Harness


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a JavaScript testcase under d8 and classify the output."
    )
    parser.add_argument("--d8", required=True, type=Path, help="Path to the d8 executable")
    parser.add_argument("--testcase", required=True, type=Path, help="Path to the JS testcase")
    parser.add_argument(
        "--flags",
        default="",
        help="Space-separated list of extra d8 flags",
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        default=Path("corpus"),
        help="Directory to persist corpus/crash metadata",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="Timeout in seconds",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if not args.testcase.exists():
        print(f"Testcase not found: {args.testcase}", file=sys.stderr)
        return 1

    d8 = D8Wrapper(d8_path=args.d8, timeout_seconds=args.timeout)
    detector = Detector()
    corpus = CorpusManager(
        corpus_dir=args.corpus,
        crashes_dir=args.corpus.parent / "crashes",
    )
    harness = Harness(d8=d8, detector=detector, corpus=corpus)

    source = args.testcase.read_text(encoding="utf-8", errors="replace")
    flags = args.flags.split() if args.flags else []

    detection = harness.evaluate(source, flags=flags, seed_id=args.testcase.stem)

    print(f"Return class: {detection.crash_class.name}")
    print(f"Title:        {detection.title}")
    print(f"Stack hash:   {detection.stack_hash}")
    print(f"Is crash:     {detection.is_crash}")
    print("--- raw output ---")
    print(detection.raw)

    return 0 if not detection.is_crash else 1


if __name__ == "__main__":
    raise SystemExit(main())
