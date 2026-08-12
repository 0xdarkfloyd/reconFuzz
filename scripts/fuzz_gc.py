"""GC-focused fuzzing loop using the dedicated gc-only generator mode."""

from __future__ import annotations

import argparse
import os
import random
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

import psutil

from src.runner.corpus_manager import CorpusManager, Seed
from src.runner.d8_wrapper import D8Wrapper
from src.runner.detector import Detector
from src.runner.harness import Harness
from src.runner.scheduler import Scheduler

try:
    from scripts.fuzz import crossover_via_daemon, mutate_via_daemon
except ImportError:  # daemon helpers optional (verbatim replay if unavailable)
    crossover_via_daemon = None
    mutate_via_daemon = None


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reconfuzz GC-focused fuzzing loop")
    parser.add_argument(
        "--d8",
        type=Path,
        default=Path("~/v8/v8/out/fuzzbuild/d8").expanduser(),
        help="Path to the V8 d8 binary (dry-run mode if it does not exist)",
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
        type=_positive_int,
        default=100,
        help="Number of iterations to run (must be greater than zero)",
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
    parser.add_argument(
        "--mutate-prob",
        type=float,
        default=0.3,
        help="Probability of mutating a replayed GC seed via the AST daemon (verbatim if the daemon is unavailable)",
    )
    parser.add_argument(
        "--crossover-prob",
        type=float,
        default=0.5,
        help="Fraction of mutations done as crossover (seed spliced with a fresh generated program)",
    )
    parser.add_argument(
        "--daemon-port",
        type=int,
        default=3000,
        help="Port for the AST daemon (mutate/crossover)",
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

        try:
            subprocess.run(cmd, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as exc:
            raw_detail = exc.stderr or exc.stdout or ""
            detail = (
                raw_detail.decode("utf-8", errors="replace")
                if isinstance(raw_detail, bytes)
                else str(raw_detail)
            ).strip()
            message = (
                f"GC generator failed (exit code {exc.returncode}) running "
                f"{shlex.join(cmd)}"
            )
            if detail:
                message += f": {detail}"
            raise subprocess.CalledProcessError(
                exc.returncode,
                exc.cmd,
                output=exc.output,
                stderr=message,
            ) from exc
        except OSError as exc:
            raise type(exc)(f"Failed to run GC generator {shlex.join(cmd)}: {exc}") from exc
        source = output_path.read_text(encoding="utf-8", errors="replace")
    finally:
        output_path.unlink(missing_ok=True)

    flags: list[str] = ["--expose-gc"]
    for line in source.splitlines():
        if line.startswith("// Flags:"):
            header_flags = line.removeprefix("// Flags:").strip().split()
            flags = list(dict.fromkeys([*flags, *header_flags]))
            break
    return source, flags


def _terminate_d8_children(d8_path: Path) -> None:
    """Terminate d8 descendants left behind by an interrupted run."""
    try:
        target = d8_path.resolve()
        children = psutil.Process(os.getpid()).children(recursive=True)
    except (OSError, psutil.Error):
        return

    matches: list[psutil.Process] = []
    for child in children:
        try:
            command = child.cmdline()
        except psutil.Error:
            continue
        if not command:
            continue
        try:
            executable = Path(command[0]).resolve()
        except OSError:
            continue
        if executable == target or command[0] == str(d8_path):
            matches.append(child)

    for child in matches:
        try:
            child.terminate()
        except psutil.Error:
            pass
    _, alive = psutil.wait_procs(matches, timeout=1.0)
    for child in alive:
        try:
            child.kill()
        except psutil.Error:
            pass


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)

    corpus = CorpusManager(args.corpus, args.crashes)
    scheduler = Scheduler()
    detector = Detector()

    dry_run: bool = args.d8 is None or not args.d8.exists()
    harness: Harness | None = None
    if not dry_run:
        shmem_coverage = D8Wrapper.probe_shmem_coverage(args.d8)
        d8 = D8Wrapper(
            args.d8,
            timeout_seconds=args.timeout,
            default_flags=["--expose-gc", "--allow-natives-syntax"],
            coverage_flags=[] if shmem_coverage else ["--trace-block-coverage"],
            shmem_coverage=shmem_coverage,
        )
        harness = Harness(d8, detector, corpus)

    # Choose the campaign seed before seeding the module RNG so an automatically
    # chosen value is printed and can be reused to reproduce the run.
    seed = args.seed if args.seed is not None else random.randint(0, 2**31 - 1)
    random.seed(seed)
    print(f"[reconfuzz-gc] seed={seed} dry_run={dry_run}")

    crashes_found = 0
    try:
        for iteration in range(1, args.iterations + 1):
            # Vary every generated testcase even when --seed is supplied; the
            # prior loop regenerated one identical program on every iteration.
            generator_seed = seed + iteration
            selected = None
            seeds = list(corpus.iter_seeds())
            if seeds and random.random() < 0.5:
                selected = scheduler.select(seeds)
                source, flags = selected.source, selected.flags
                # Structure-aware mutation/crossover via the daemon (mirrors
                # fuzz.py). Falls back to verbatim if the daemon is unavailable
                # or the mutation is a no-op.
                if mutate_via_daemon is not None and random.random() < args.mutate_prob:
                    if random.random() < args.crossover_prob:
                        source = crossover_via_daemon(source, generator_seed, args.daemon_port)
                    else:
                        source = mutate_via_daemon(source, args.daemon_port)
            else:
                source, flags = generate_gc_source(generator_seed)

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

            if seeds and iteration % 10 == 0:
                selected_id = selected.id if selected else "generated"
                print(f"[{iteration}/{args.iterations}] corpus={len(seeds)} selected={selected_id}")
    except KeyboardInterrupt:
        if not dry_run:
            _terminate_d8_children(args.d8)
        print("\n[reconfuzz-gc] interrupted by user", flush=True)
        return 130
    except BaseException:
        if not dry_run:
            _terminate_d8_children(args.d8)
        raise

    print(
        f"[reconfuzz-gc] completed {args.iterations} iterations; "
        f"corpus={sum(1 for _ in corpus.iter_seeds())} crashes={crashes_found}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
