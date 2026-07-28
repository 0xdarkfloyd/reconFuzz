"""Main reconfuzz fuzzing loop."""

from __future__ import annotations

import argparse
import random
import subprocess
import sys
import urllib.request
import urllib.error
import time
import concurrent.futures
from pathlib import Path
import subprocess
import sys
import argparse
import random

from src.runner.corpus_manager import CorpusManager, Seed
from src.runner.d8_wrapper import D8Wrapper
from src.runner.detector import Detector
from src.runner.harness import Harness
from src.runner.scheduler import Scheduler, SchedulerConfig


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reconfuzz continuous fuzzing loop")
    parser.add_argument(
        "--d8",
        type=Path,
        default=None,
        help="Path to the V8 d8 binary (optional; dry-run mode if omitted)",
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        default=Path("seeds/corpus"),
        help="Directory to store interesting seeds",
    )
    parser.add_argument(
        "--crashes",
        type=Path,
        default=Path("seeds/crashes"),
        help="Directory to store crashes",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=100,
        help="Number of iterations to run",
    )
    parser.add_argument(
        "--mode",
        choices=("js-only", "wasm-only", "hybrid"),
        default="hybrid",
        help="Generator mode",
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
        default=10.0,
        help="d8 timeout in seconds",
    )
    parser.add_argument(
        "--scheduler-config",
        type=Path,
        default=None,
        help="Optional YAML scheduler config",
    )
    return parser


def get_source_from_daemon(mode: str, seed: int | None, port: int = 3000) -> tuple[str, list[str]]:
    """Fetch AST source code from the background Node daemon via HTTP (Replaces generate_source)."""
    url = f"http://127.0.0.1:{port}/generate?mode={mode}"
    if seed is not None:
        url += f"&seed={seed}"
        
    try:
        with urllib.request.urlopen(url) as response:
            source = response.read().decode("utf-8")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Failed to fetch AST from daemon: {e}")

    flags: list[str] = []
    if source.startswith("// Flags:"):
        flags = source.splitlines()[0].replace("// Flags:", "").strip().split()
    return source, flags

def worker_task(iteration: int, args, harness_override=None) -> tuple[int, bool, "Detection | None", "Seed | None"]:
    """Worker process payload executed simultaneously."""
    seed = iteration if args.seed is None else args.seed + iteration
    source, flags = get_source_from_daemon(args.mode, seed)

    if harness_override is not None:
        detection = harness_override.evaluate(source, flags=flags)
        return iteration, True, detection, None
    else:
        seed_obj = Seed(
            id=f"iter_{iteration}",
            source=source,
            flags=flags,
            crash_class="NONE",
            stack_hash=f"dry-run-{iteration}",
        )
        return iteration, False, None, seed_obj

def build_scheduler(config_path: Path | None) -> Scheduler:
    """Build scheduler, optionally loading config from YAML."""
    if config_path is None:
        return Scheduler()

    try:
        import yaml

        data = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
        return Scheduler(SchedulerConfig(**data))
    except ImportError as exc:
        raise ImportError("PyYAML is required to load --scheduler-config") from exc


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)

    corpus = CorpusManager(args.corpus, args.crashes)
    scheduler = build_scheduler(args.scheduler_config)
    detector = Detector()

    dry_run: bool = args.d8 is None or not args.d8.exists()
    harness: Harness | None = None
    if not dry_run:
        d8 = D8Wrapper(args.d8, timeout_seconds=args.timeout)
        harness = Harness(d8, detector, corpus)

    # 1. Start the Node API Daemon
    server_script = Path(__file__).resolve().parent.parent / "dist" / "generator" / "server.js"
    daemon_proc = subprocess.Popen(["node", str(server_script)])
    time.sleep(1.0) # Give the Node server a moment to start up

    print(f"[reconfuzz] mode={args.mode} dry_run={dry_run} utilizing ProcessPool")

    crashes_found = 0
    try:
        # 2. Setup the Executor pool (uses available CPU cores)
        with concurrent.futures.ProcessPoolExecutor() as executor:
            futures = {
                executor.submit(worker_task, it, args, harness): it 
                for it in range(1, args.iterations + 1)
            }

            for future in concurrent.futures.as_completed(futures):
                iteration, has_eval, detection, seed_obj = future.result()

                if has_eval and dict:
                    if detection and detection.is_crash:
                        crashes_found += 1
                        print(f"[{iteration}/{args.iterations}] CRASH: {detection.crash_class.name} - {detection.title}")
                elif not has_eval and seed_obj:
                    corpus.add_seed(seed_obj)

    finally:
        # 3. Teardown the Node daemon
        daemon_proc.terminate()
        daemon_proc.wait()

    summary = (
        f"[reconfuzz] completed {args.iterations} iterations; "
        f"corpus={sum(1 for _ in corpus.iter_seeds())} crashes={crashes_found}"
    )
    print(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
