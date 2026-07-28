"""GC-focused fuzzing loop using the dedicated gc-only generator mode."""

from __future__ import annotations

import argparse
import random
import subprocess
import sys
import tempfile
from pathlib import Path

from src.runner.corpus_manager import CorpusManager, Seed
from src.runner.d8_wrapper import D8Wrapper
from src.runner.detector import Detector
from src.runner.harness import Harness
from src.runner.scheduler import Scheduler


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reconfuzz GC-focused fuzzing loop")
    parser.add_argument(
        "--d8",
        type=Path,
        default=None,
        help="Path to the V8 d8 binary (optional; dry-run mode if omitted)",
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        default=Path("seeds/gc-corpus"),
        help="Directory to store interesting seeds",
    )
    parser.add_argument(
        "--crashes",
        type=Path,
        default=Path("seeds/gc-crashes"),
        help="Directory to store crashes",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=100,
        help="Number of iterations to run",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Random seed for the generator",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=15.0,
        help="d8 timeout in seconds",
    )
    return parser


def generate_gc_source(seed: int | None) -> tuple[str, list[str]]:
    """Invoke the TypeScript generator in gc-only mode."""
    generator_script = Path(__file__).resolve().parent.parent / "dist" / "generator" / "index.js"
    if not generator_script.exists():
        raise FileNotFoundError(
            f"Generator not built: {generator_script}. Run 'npm run build' first."
        )

    with tempfile.NamedTemporaryFile(mode="w", suffix=".js", delete=False) as tmp:
        output_path = Path(tmp.name)

    try:
        cmd = [
            "node",
            str(generator_script),
            "--mode",
            "gc-only",
            "--output",
            str(output_path),
        ]
        if seed is not None:
            cmd.extend(["--seed", str(seed)])

        subprocess.run(cmd, check=True, capture_output=True, text=True)
        source = output_path.read_text(encoding="utf-8", errors="replace")
    finally:
        output_path.unlink(missing_ok=True)

    flags: list[str] = ["--expose-gc"]
    if source.startswith("// Flags:"):
        header_flags = source.splitlines()[0].replace("// Flags:", "").strip().split()
        flags = list(dict.fromkeys([*flags, *header_flags]))
    return source, flags


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)

    corpus = CorpusManager(args.corpus, args.crashes)
    scheduler = Scheduler()
    detector = Detector()

    dry_run: bool = args.d8 is None or not args.d8.exists()
    harness: Harness | None = None
    if not dry_run:
        d8 = D8Wrapper(args.d8, timeout_seconds=args.timeout)
        harness = Harness(d8, detector, corpus)

    seed = args.seed if args.seed is not None else random.randint(0, 2**31 - 1)
    random.seed(seed)
    print(f"[reconfuzz-gc] seed={seed} dry_run={dry_run}")

    crashes_found = 0
    for iteration in range(1, args.iterations + 1):
        source, flags = generate_gc_source(iteration if args.seed is None else args.seed)

        if harness is not None:
            detection = harness.evaluate(source, flags=flags)
            if detection.is_crash:
                crashes_found += 1
                print(
                    f"[{iteration}/{args.iterations}] CRASH: {detection.crash_class.name} "
                    f"- {detection.title}"
                )
        else:
            seed_obj = Seed(
                id=f"gc_{iteration}",
                source=source,
                flags=flags,
                crash_class="NONE",
                stack_hash=f"dry-run-{iteration}",
            )
            corpus.add_seed(seed_obj)

        seeds = list(corpus.iter_seeds())
        if seeds and iteration % 10 == 0:
            selected = scheduler.select(seeds)
            print(f"[{iteration}/{args.iterations}] corpus={len(seeds)} " f"selected={selected.id}")

    print(
        f"[reconfuzz-gc] completed {args.iterations} iterations; "
        f"corpus={sum(1 for _ in corpus.iter_seeds())} crashes={crashes_found}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
