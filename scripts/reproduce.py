"""Reproduce a single testcase under d8 and print detection results.

Exit status is 0 when no run is classified as a finding, 1 when at least one
run is a finding, and 2 for invalid arguments or tool/testcase paths.
"""

from __future__ import annotations

import argparse
import math
import os
import shlex
import sys
from pathlib import Path

# Allow importing the runner package without installation.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.runner import CorpusManager, D8Wrapper, Detection, Detector, Harness


def _positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _positive_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive float") from exc
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive float")
    return parsed


def _split_flags(value: str) -> list[str]:
    try:
        return shlex.split(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid flag string: {exc}") from exc


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a JavaScript testcase under d8 and classify the output.",
        epilog=(
            "Exit status: 0 = no finding; 1 = at least one finding; "
            "2 = tool or usage error."
        ),
    )
    parser.add_argument("--d8", required=True, type=Path, help="Path to the d8 executable")
    parser.add_argument("--testcase", required=True, type=Path, help="Path to the JS testcase")
    parser.add_argument(
        "--flags",
        type=_split_flags,
        default=[],
        help="Shell-style string of extra d8 flags",
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        default=Path("corpus"),
        help="Directory to persist corpus/crash metadata",
    )
    parser.add_argument(
        "--crashes",
        type=Path,
        default=None,
        help="Directory to persist crash metadata (default: sibling of --corpus)",
    )
    parser.add_argument(
        "--timeout",
        type=_positive_float,
        default=10.0,
        help="Timeout in seconds",
    )
    parser.add_argument(
        "--iterations",
        type=_positive_int,
        default=1,
        help="Number of times to run the testcase",
    )
    args = parser.parse_args(argv)
    if args.crashes is None:
        args.crashes = args.corpus.parent / "crashes"
    return args


def _validate_inputs(args: argparse.Namespace) -> str | None:
    """Return a concise path error, or ``None`` when inputs are runnable."""
    if not args.testcase.is_file():
        return f"Testcase not found: {args.testcase}"
    if not args.d8.is_file() or not os.access(args.d8, os.X_OK):
        return f"d8 is missing or not executable: {args.d8}"
    return None


def _print_detection(detection: Detection) -> None:
    """Print the stable detailed result format used by the CLI."""
    print(f"Return class: {detection.crash_class.name}")
    print(f"Title:        {detection.title}")
    print(f"Stack hash:   {detection.stack_hash}")
    print(f"Is crash:     {detection.is_crash}")
    print("--- raw output ---")
    print(detection.raw)


def main() -> int:
    args = parse_args()

    input_error = _validate_inputs(args)
    if input_error is not None:
        print(f"[reproduce] {input_error}", file=sys.stderr)
        return 2

    flags = shlex.split(args.flags) if isinstance(args.flags, str) else args.flags
    first_detection: Detection | None = None
    finding_count = 0
    try:
        d8 = D8Wrapper(d8_path=args.d8, timeout_seconds=args.timeout)
        detector = Detector()
        corpus = CorpusManager(
            corpus_dir=args.corpus,
            crashes_dir=args.crashes,
        )
        harness = Harness(d8=d8, detector=detector, corpus=corpus)

        source = args.testcase.read_text(encoding="utf-8", errors="replace")
        for _ in range(args.iterations):
            detection = harness.evaluate(source, flags=flags, seed_id=args.testcase.stem)
            if first_detection is None:
                first_detection = detection
            finding_count += int(detection.is_crash)
    except OSError as exc:
        print(f"[reproduce] tool execution failed: {exc}", file=sys.stderr)
        return 2

    assert first_detection is not None
    _print_detection(first_detection)

    if args.iterations > 1:
        print(
            f"[reproduce] iterations={args.iterations} findings={finding_count}",
            file=sys.stderr,
        )

    return 1 if finding_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
