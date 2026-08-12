"""Main reconfuzz fuzzing loop."""

from __future__ import annotations

import argparse
import atexit
import concurrent.futures
import json
import multiprocessing
import os
import random
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from src.runner.corpus_manager import CorpusManager, Seed
from src.runner.coverage_union import CoverageUnion
from src.runner.d8_wrapper import D8Wrapper
from src.runner.detector import Detection, Detector
from src.runner.harness import Harness
from src.runner.reprl import ReprlRunner
from src.runner.scheduler import Scheduler, SchedulerConfig

# Baseline d8 flags for every run: expose GC/testing hooks, keep the shell
# alive after quit() (--omit-quit), and enable experimental JIT/syntax paths
# that fuzzing is meant to stress. Per-testcase flags from the "// Flags:"
# line are appended on top.
FUZZING_FLAGS = [
    "--expose-gc",
    "--omit-quit",
    "--allow-natives-syntax",
    "--fuzzing",
    "--jit-fuzzing",
    "--future",
    "--harmony",
    "--js-staging",
    "--shared-string-table",
    "--experimental-wasm-compilation-hints",
    "--maglev-future",
    "--turboshaft-assert-types",
    "--assert-types",
    "--stress-gc",
    "--gc-interval=5000",
]


def _nonnegative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be non-negative")
    return parsed


def _probability(value: str) -> float:
    parsed = float(value)
    if not 0.0 <= parsed <= 1.0:
        raise argparse.ArgumentTypeError("must be between 0 and 1")
    return parsed


def adjust_op_mix(
    yields: dict[str, int],
    replay_prob: float,
    crossover_prob: float,
    smoothing: float = 0.3,
) -> tuple[float, float]:
    """Adjust replay and crossover probabilities toward observed yields."""
    generate_yield = yields.get("generate", 0)
    mutate_yield = yields.get("mutate", 0)
    crossover_yield = yields.get("crossover", 0)
    replay_yield = mutate_yield + crossover_yield
    total_yield = generate_yield + replay_yield
    if total_yield == 0:
        return replay_prob, crossover_prob

    def clamp(value: float, lower: float, upper: float) -> float:
        return max(lower, min(upper, value))

    replay_target = replay_yield / total_yield
    new_replay_prob = clamp(
        (1.0 - smoothing) * replay_prob + smoothing * replay_target,
        0.1,
        0.7,
    )
    crossover_target = crossover_yield / replay_yield if replay_yield else crossover_prob
    new_crossover_prob = clamp(
        (1.0 - smoothing) * crossover_prob + smoothing * crossover_target,
        0.1,
        0.9,
    )
    return new_replay_prob, new_crossover_prob


def _extract_flags(source: str) -> list[str]:
    """Return the d8 flags declared by a generated or imported testcase."""
    prefix = "// Flags:"
    for line in source.splitlines():
        if line.startswith(prefix):
            return line.removeprefix(prefix).strip().split()
    return []


def _merge_flags(existing: list[str], discovered: list[str]) -> list[str]:
    """Append newly discovered flags without disturbing meaningful ordering."""
    merged = list(existing)
    merged.extend(flag for flag in discovered if flag not in merged)
    return merged


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reconfuzz continuous fuzzing loop")
    parser.add_argument(
        "--d8",
        type=Path,
        default=Path("~/v8/v8/out/fuzzbuild/d8").expanduser(),
        help="Path to the V8 d8 binary (dry-run mode if it does not exist)",
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
        type=_nonnegative_int,
        default=100,
        help="Number of iterations to run (0 = run continuously until Ctrl+C)",
    )
    parser.add_argument(
        "--batch-size",
        type=_nonnegative_int,
        default=0,
        help="Tasks in flight per batch (default: 4x CPU count)",
    )
    parser.add_argument(
        "--workers",
        type=_nonnegative_int,
        default=0,
        help="Worker processes (default: all CPU cores)",
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
    parser.add_argument(
        "--replay-prob",
        type=_probability,
        default=0.25,
        help="Probability of replaying a (structure-mutated) corpus seed instead of a generated testcase",
    )
    parser.add_argument(
        "--crossover-prob",
        type=_probability,
        default=0.5,
        help="Fraction of replays done as crossover (seed spliced with a fresh generated program) instead of plain mutation",
    )
    parser.add_argument(
        "--adaptive-mix",
        action="store_true",
        default=False,
        help="Adapt operation probabilities from novel-coverage admissions",
    )
    parser.add_argument(
        "--admission",
        choices=("gain", "hash"),
        default="gain",
        help=(
            "Corpus admission policy: 'gain' retains a testcase only when its "
            "native edge bitmap covers at least one globally new edge (and "
            "retained seeds feed replay/mutation); 'hash' retains on any "
            "unseen exact coverage hash"
        ),
    )
    parser.add_argument(
        "--exec",
        choices=("reprl", "process"),
        default="reprl",
        help=(
            "Execution backend: 'reprl' keeps one persistent d8 per worker "
            "via the Fuzzilli REPRL protocol (much faster; fixed flag set, "
            "per-testcase // Flags are ignored). 'process' spawns a fresh d8 "
            "per testcase and honors per-testcase flags (the slow fallback)"
        ),
    )
    return parser


def get_source_from_daemon(mode: str, seed: int | None, port: int = 3000) -> tuple[str, list[str]]:
    """Fetch AST source code from the background Node daemon via HTTP (Replaces generate_source)."""
    url = f"http://127.0.0.1:{port}/generate?mode={mode}"
    if seed is not None:
        url += f"&seed={seed}"

    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            source = response.read().decode("utf-8")
    except (urllib.error.URLError, UnicodeError, OSError) as e:
        raise RuntimeError(f"Failed to fetch AST from daemon: {e}")

    return source, _extract_flags(source)


def mutate_via_daemon(source: str, port: int = 3000) -> str:
    """POST a testcase to the daemon's /mutate endpoint (structure-aware
    AST mutation). On any failure the source is returned unchanged."""
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/mutate",
            data=source.encode("utf-8"),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            return bytes(response.read()).decode("utf-8")
    except (urllib.error.URLError, UnicodeError, OSError):
        return source


def crossover_via_daemon(source: str, seed: int, port: int = 3000) -> str:
    """POST a corpus seed to the daemon's /crossover endpoint: the seed is
    spliced with a freshly generated program that can reference the seed's
    top-level declarations. On any failure the source is returned unchanged."""
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/crossover?seed={seed}",
            data=source.encode("utf-8"),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            return bytes(response.read()).decode("utf-8")
    except (urllib.error.URLError, UnicodeError, OSError):
        return source

# Worker-process globals. Each forked worker builds its runner ONCE in
# worker_init and reuses it for every task: under REPRL that means one
# persistent d8 child for the worker's whole lifetime (no per-testcase
# spawn); under "process" mode it is a D8Wrapper reused across tasks.
_WORKER_HARNESS: Harness | None = None
_WORKER_RUNNER: D8Wrapper | ReprlRunner | None = None
# Shared gain-admission oracle (REPRL + gain mode only). Lets each worker
# decide novelty in-process so the ~300KB per-testcase bitmap never travels
# back to the parent.
_WORKER_UNION: CoverageUnion | None = None


def worker_init(
    args: argparse.Namespace, exec_mode: str, dry_run: bool, union_name: str | None
) -> None:
    """Create the per-worker harness once. Called by ProcessPoolExecutor."""
    global _WORKER_HARNESS, _WORKER_RUNNER, _WORKER_UNION
    if dry_run:
        return
    if union_name:
        _WORKER_UNION = CoverageUnion.attach(
            union_name, args.corpus / CorpusManager.UNION_PATH
        )
    if exec_mode == "reprl":
        _WORKER_RUNNER = ReprlRunner(
            args.d8, default_flags=FUZZING_FLAGS, timeout_seconds=args.timeout
        )
    else:
        _WORKER_RUNNER = D8Wrapper(
            args.d8,
            timeout_seconds=args.timeout,
            default_flags=FUZZING_FLAGS,
            coverage_flags=[],
            shmem_coverage=D8Wrapper.probe_shmem_coverage(args.d8),
        )
    _WORKER_HARNESS = Harness(_WORKER_RUNNER, Detector(), None)
    # Workers are recycled via SIGTERM; make sure the persistent d8 child
    # does not outlive its worker, and is not left for init to reap.
    atexit.register(_close_worker_runner)
    signal.signal(signal.SIGTERM, _worker_sigterm)


def _close_worker_runner() -> None:
    if isinstance(_WORKER_RUNNER, ReprlRunner):
        _WORKER_RUNNER.close()


def _worker_sigterm(_signum: int, _frame: object) -> None:
    _close_worker_runner()
    os._exit(0)


def _reap_orphan_d8(d8_path: str) -> None:
    """Parent safety-net: kill any REPRL d8 children orphaned by SIGKILLed
    workers. Scoped to the exact fuzzbuild d8 path so unrelated d8 runs are
    never touched."""
    import signal as _signal

    try:
        out = subprocess.run(
            ["pgrep", "-f", d8_path], capture_output=True, text=True, check=False
        )
    except OSError:
        return
    for pid_s in out.stdout.split():
        try:
            os.kill(int(pid_s), _signal.SIGKILL)
        except (OSError, ValueError):
            pass


def _maybe_admit(detection: Detection | None, seed_obj: Seed | None) -> Seed | None:
    """Apply in-worker gain admission and decide what to persist.

    Under REPRL+gain a shared CoverageUnion is mapped in the worker, so the
    gain check (and the bitmap merge) happens here -- the ~300KB bitmap is
    never shipped to the parent. A non-novel, non-crash run returns None and
    is skipped entirely; a crash is always returned for triage; in process
    mode (no shared union) the bitmap travels to the parent as before.
    """
    if seed_obj is None:
        return None
    if detection is not None and detection.is_crash:
        seed_obj.coverage_bitmap = None
        return seed_obj
    if _WORKER_UNION is not None and seed_obj.coverage_bitmap is not None:
        if not _WORKER_UNION.check_and_merge(seed_obj.coverage_bitmap):
            return None
        seed_obj.coverage_bitmap = None  # gained; union already updated
    return seed_obj


def worker_task(
    iteration: int,
    args: argparse.Namespace,
    replay_id: str | None = None,
) -> tuple[int, bool, Detection | None, Seed | None, bool, str]:
    """Worker process payload executed simultaneously.

    Uses the worker-global harness created by :func:`worker_init`, so the
    execution backend (REPRL vs per-process) is transparent here.
    """
    seed = iteration if args.seed is None else args.seed + iteration
    # Forked workers inherit Python's PRNG state. Mix in the task identity so
    # replay/crossover choices do not repeat in lockstep across processes.
    task_rng = random.Random(seed ^ (os.getpid() << 16))

    harness = _WORKER_HARNESS
    # REPRL runs with a fixed flag set, so per-testcase // Flags are dropped.
    honor_flags = not isinstance(_WORKER_RUNNER, ReprlRunner)

    # The parent selects replay_id through Scheduler for every task. This
    # makes newly admitted corpus entries immediately visible to workers and
    # keeps scheduling state in one process.
    if harness is not None and replay_id is not None:
        path = args.corpus / replay_id / "testcase.js"
        try:
            source = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            source = ""
        if source:
            original_source = source
            flags: list[str] = []
            if honor_flags:
                flags = _extract_flags(source)
                if not flags:
                    try:
                        metadata = json.loads(
                            (path.parent / "meta.json").read_text(encoding="utf-8")
                        )
                        flags = list(metadata.get("flags", []))
                    except (json.JSONDecodeError, OSError, TypeError):
                        pass
            if task_rng.random() < args.crossover_prob:
                operation = "crossover"
                source = crossover_via_daemon(source, seed)
            else:
                operation = "mutate"
                source = mutate_via_daemon(source)
            if source == original_source:
                # Never spend execution budget replaying an unchanged corpus
                # file after a daemon parse/network failure or exhausted
                # no-op mutation attempts. Fall back to fresh generation.
                source, gen_flags = get_source_from_daemon(args.mode, seed)
                if harness is not None:
                    detection, seed_obj = harness.run_source(source, flags=gen_flags if honor_flags else [])
                    return iteration, True, detection, _maybe_admit(detection, seed_obj), False, "generate"
            if honor_flags:
                # Crossover can introduce constructs that need flags absent
                # from the corpus parent. The daemon records those additions
                # in the transformed source's header.
                flags = _merge_flags(flags, _extract_flags(source))
            detection, seed_obj = harness.run_source(source, flags=flags)
            return iteration, True, detection, _maybe_admit(detection, seed_obj), True, operation

    source, flags = get_source_from_daemon(args.mode, seed)

    if harness is not None:
        detection, seed_obj = harness.run_source(source, flags=flags if honor_flags else [])
        return iteration, True, detection, _maybe_admit(detection, seed_obj), False, "generate"
    else:
        seed_obj = Seed(
            id=f"iter_{iteration}",
            source=source,
            flags=flags,
            crash_class="NONE",
            stack_hash=f"dry-run-{iteration}",
        )
        return iteration, False, None, seed_obj, False, "generate"

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

    scheduler = build_scheduler(args.scheduler_config)

    dry_run: bool = args.d8 is None or not args.d8.exists()
    # The execution backend lives in each worker (see worker_init) so a REPRL
    # runner keeps its d8 child alive for the worker's whole lifetime. The
    # parent only orchestrates generation/replay selection and persistence.
    shmem_coverage = not dry_run and D8Wrapper.probe_shmem_coverage(args.d8)
    if not dry_run:
        atexit.register(_reap_orphan_d8, str(args.d8))
    if dry_run:
        coverage_mode = "none"
    elif args.exec == "reprl":
        coverage_mode = "reprl+shmem-edges"
    else:
        coverage_mode = "shmem-edges" if shmem_coverage else "text"
    if not dry_run and args.exec == "reprl" and not shmem_coverage:
        print(
            "[reconfuzz] WARNING: --exec reprl needs a Fuzzilli-instrumented "
            "build; falling back to --exec process"
        )
        args.exec = "process"

    # In REPRL + gain mode, a shared CoverageUnion lets workers do gain
    # admission in-process (no per-result bitmap IPC). The parent owns the
    # union file; CorpusManager then defers to it.
    union: CoverageUnion | None = None
    union_name: str | None = None
    manage_union = True
    if not dry_run and args.exec == "reprl" and args.admission == "gain":
        union = CoverageUnion.create(args.corpus / CorpusManager.UNION_PATH)
        union_name = union.name
        manage_union = False

    corpus = CorpusManager(
        args.corpus, args.crashes, admission=args.admission, manage_union=manage_union
    )

    # 1. Start the Node API Daemon (bigger heap: it OOMed at the default
    # ~4GB after hours of mutating/crossing large corpus files).
    server_script = Path(__file__).resolve().parent.parent / "dist" / "generator" / "server.js"
    daemon_proc = subprocess.Popen(
        ["node", "--max-old-space-size=8192", str(server_script)]
    )
    time.sleep(1.0)  # Give the Node server a moment to start up
    if daemon_proc.poll() is not None:
        raise RuntimeError(f"generator daemon exited during startup (rc={daemon_proc.returncode})")

    continuous = args.iterations == 0
    batch_size = args.batch_size or max(32, (os.cpu_count() or 4) * 4)
    print(
        f"[reconfuzz] mode={args.mode} dry_run={dry_run} "
        f"continuous={continuous} batch_size={batch_size} "
        f"workers={args.workers or os.cpu_count()} replay_prob={args.replay_prob} "
        f"crossover_prob={args.crossover_prob} d8={args.d8} coverage={coverage_mode} "
        f"admission={args.admission} exec={args.exec}"
    )

    crash_stats: dict[str, int] = {}
    executed = 0
    replayed = 0
    seed_list_cache: list[Seed] | None = None
    worker_errors = 0
    replay_prob = args.replay_prob
    crossover_prob = args.crossover_prob
    op_yields: dict[str, int] | None = (
        {"generate": 0, "mutate": 0, "crossover": 0} if args.adaptive_mix else None
    )
    novel_admissions_since_mix = 0
    next_iteration = 1
    start_time = time.time()
    interrupted = False
    # Use the "fork" start method: Python 3.14's default "forkserver" runs
    # workers in their own session, which puts them out of reach of both
    # terminal Ctrl+C and our killpg-based shutdown. Fork children stay in
    # our process group.
    fork_ctx = multiprocessing.get_context("fork")
    # Manage the executor explicitly so Ctrl+C can cancel queued tasks
    # instead of draining the whole in-flight batch.
    try:
        executor = concurrent.futures.ProcessPoolExecutor(
            max_workers=args.workers or None,
            mp_context=fork_ctx,
            initializer=worker_init,
            initargs=(args, args.exec, dry_run, union_name),
        )
    except BaseException:
        daemon_proc.terminate()
        daemon_proc.wait()
        raise
    try:
        # 2. Sliding window: keep `batch_size` tasks in flight and submit a
        # new one the moment any task completes. A per-batch barrier used to
        # let one 10s timeout idle every other worker, which collapsed d8
        # concurrency to 1-2 processes.
        total_to_run = args.iterations  # 0 = continuous
        pending: set[
            concurrent.futures.Future[
                tuple[int, bool, Detection | None, Seed | None, bool, str]
            ]
        ] = set()

        def choose_replay_id() -> str | None:
            nonlocal seed_list_cache
            if dry_run or replay_prob <= 0 or random.random() >= replay_prob:
                return None
            if seed_list_cache is None:
                seed_list_cache = list(corpus.iter_seed_metadata())
            if not seed_list_cache:
                return None
            return scheduler.select(seed_list_cache).id

        def record_novel_admission(operation: object) -> None:
            nonlocal replay_prob, crossover_prob, novel_admissions_since_mix
            if op_yields is None:
                return
            operation_name = operation if operation in op_yields else "generate"
            op_yields[operation_name] += 1
            novel_admissions_since_mix += 1
            if novel_admissions_since_mix < 20:
                return
            replay_prob, crossover_prob = adjust_op_mix(
                op_yields, replay_prob, crossover_prob
            )
            # New submissions receive the current crossover probability when
            # their argument namespace is pickled for the worker.
            args.replay_prob = replay_prob
            args.crossover_prob = crossover_prob
            novel_admissions_since_mix = 0

        def submit_next() -> bool:
            nonlocal next_iteration
            if not continuous and next_iteration > total_to_run:
                return False
            pending.add(
                executor.submit(
                    worker_task,
                    next_iteration,
                    args,
                    choose_replay_id(),
                )
            )
            next_iteration += 1
            return True

        def restart_daemon_if_needed() -> None:
            nonlocal daemon_proc
            if daemon_proc.poll() is None:
                return
            print(
                f"[reconfuzz] daemon exited (rc={daemon_proc.returncode}), "
                "restarting..."
            )
            daemon_proc = subprocess.Popen(
                ["node", "--max-old-space-size=8192", str(server_script)]
            )
            time.sleep(1.0)
            if daemon_proc.poll() is not None:
                raise RuntimeError(
                    "generator daemon exited during restart "
                    f"(rc={daemon_proc.returncode})"
                )

        window = batch_size if continuous else min(batch_size, total_to_run)
        for _ in range(window):
            submit_next()

        stats_every = batch_size
        since_stats = 0
        while pending:
            done, pending = concurrent.futures.wait(
                pending, return_when=concurrent.futures.FIRST_COMPLETED
            )
            for future in done:
                try:
                    result = future.result()
                    _iteration, has_eval, detection, seed_obj = result[:4]
                    is_replay = result[4] if len(result) > 4 else False
                    operation = result[5] if len(result) > 5 else "generate"
                except Exception as exc:  # noqa: BLE001 - isolate one bad worker task
                    # A worker failure (daemon hiccup, vanished file, ...) must
                    # not kill the pipeline — count it and move on.
                    worker_errors += 1
                    if worker_errors % 100 == 1:
                        print(f"[reconfuzz] worker errors so far: {worker_errors} (latest: {type(exc).__name__}: {exc})")
                    # A dead daemon makes every queued and replacement task
                    # fail. Recover here because successful-result statistics
                    # may never advance far enough to run the periodic check.
                    restart_daemon_if_needed()
                    submit_next()
                    continue
                executed += 1
                since_stats += 1
                if is_replay:
                    replayed += 1

                if has_eval:
                    # Persistence happens ONLY here, in the parent, with a
                    # single CorpusManager. Workers used to save through
                    # per-task pickled harness copies whose dedup sets were
                    # always pristine, so duplicates flooded the crashes dir.
                    if detection and detection.is_crash:
                        name = detection.crash_class.name
                        crash_stats[name] = crash_stats.get(name, 0) + 1
                        tag = " [replay]" if is_replay else ""
                        print(f"[{executed}] CRASH:{tag} {name} - {detection.title}")
                        if seed_obj:
                            corpus.add_crash(seed_obj)
                    elif seed_obj:
                        admitted = corpus.add_seed(seed_obj)
                        if admitted:
                            seed_list_cache = None
                            record_novel_admission(operation)
                elif seed_obj:
                    admitted = corpus.add_seed(seed_obj)
                    if admitted:
                        seed_list_cache = None
                        record_novel_admission(operation)

                submit_next()

            if since_stats >= stats_every:
                since_stats = 0
                # Persist the shared gain-union so admission survives restarts.
                if union is not None:
                    union.save()
                # Daemon watchdog: restart it if it died (e.g. OOM) so
                # workers stop failing on connection resets.
                restart_daemon_if_needed()
                elapsed = max(time.time() - start_time, 1e-9)
                rate = executed / elapsed
                total_crashes = sum(crash_stats.values())
                print(
                    f"[reconfuzz] executed={executed} replayed={replayed} rate={rate:.1f}/s "
                    f"findings={total_crashes} by_class={crash_stats or '{}'} "
                    f"worker_errors={worker_errors}"
                )
    except KeyboardInterrupt:
        interrupted = True
        # Ignore repeated terminal interrupts while cleanup is in progress.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        print("\n[reconfuzz] interrupted by user, shutting down...", flush=True)
    except BaseException:
        # Preserve the original exception while ensuring forked d8 workers
        # and the generator daemon do not survive a failed campaign.
        worker_processes = list((getattr(executor, "_processes", None) or {}).values())
        executor.shutdown(wait=False, cancel_futures=True)
        for process in worker_processes:
            if process.is_alive():
                process.terminate()
        if daemon_proc.poll() is None:
            daemon_proc.terminate()
            daemon_proc.wait()
        raise

    # Counting directories is enough here; iter_seeds() would re-read every
    # testcase from disk, which can stall shutdown on large corpora.
    if union is not None:
        union.save(force=True)
        union.close(unlink=True)
    corpus_size = sum(1 for d in args.corpus.iterdir() if d.is_dir())
    summary = (
        f"[reconfuzz] {'interrupted after' if interrupted else 'completed'} "
        f"{executed} iterations; "
        f"corpus={corpus_size} "
        f"findings={sum(crash_stats.values())} by_class={crash_stats or '{}'}"
    )

    if interrupted:
        # Cancel queued work and terminate only the processes this loop owns.
        # Killing the entire process group can also kill the user's shell when
        # the fuzzer was launched directly from a terminal.
        worker_processes = list((getattr(executor, "_processes", None) or {}).values())
        executor.shutdown(wait=False, cancel_futures=True)
        for process in worker_processes:
            if process.is_alive():
                process.terminate()
        if daemon_proc.poll() is None:
            daemon_proc.terminate()
            try:
                daemon_proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                daemon_proc.kill()
        print(summary, flush=True)
        return 130

    executor.shutdown(wait=True)
    daemon_proc.terminate()
    daemon_proc.wait()
    print(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
