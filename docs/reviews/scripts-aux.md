# Auxiliary Script Review

## 1. Structure map

### `scripts/fuzz_gc.py`

- The CLI accepts the engine path, corpus and result directories, a positive iteration count, an optional campaign seed, and an engine timeout (`scripts/fuzz_gc.py:30-68`).
- Startup constructs the corpus manager, scheduler, and detector; it constructs the wrapper and harness only when the engine path exists, otherwise selecting dry-run mode (`scripts/fuzz_gc.py:166-184`).
- A campaign seed is chosen once, installed into Python's module RNG, and printed; each fresh testcase receives `campaign_seed + iteration` (`scripts/fuzz_gc.py:186-197`).
- Every iteration materializes the current seed collection, then either selects one existing seed with 50% probability or invokes fresh GC-only generation (`scripts/fuzz_gc.py:194-205`). The replay branch assigns the selected seed's source and flags directly (`scripts/fuzz_gc.py:200-204`).
- Active runs delegate one evaluation to `Harness`; dry runs instead add the selected or generated source as a `Seed`, and periodic progress uses the collection snapshot taken before that iteration's evaluation/addition (`scripts/fuzz_gc.py:206-226`).
- Within this script there is no daemon lifecycle: each fresh generation is a blocking `node` subprocess, while engine execution is delegated per iteration to `Harness.evaluate` (`scripts/fuzz_gc.py:83-95`, `scripts/fuzz_gc.py:206-207`). Interrupted or exceptional active runs perform a best-effort cleanup of descendant processes matching the engine path (`scripts/fuzz_gc.py:130-163`, `scripts/fuzz_gc.py:227-235`).

### `scripts/reproduce.py`

- Argument parsing requires engine and testcase paths, shell-splits one extra-flag string, validates positive finite timeout and positive iterations, and derives a default results directory from the corpus path (`scripts/reproduce.py:23-47`, `scripts/reproduce.py:50-93`).
- Input validation checks that the testcase is a file and the engine is an executable file before constructing the wrapper, detector, corpus manager, and harness (`scripts/reproduce.py:96-102`, `scripts/reproduce.py:115-133`).
- The testcase is decoded once with replacement for invalid UTF-8 and evaluated repeatedly with the same flags and seed identifier (`scripts/reproduce.py:135-140`).
- Detailed output is emitted only for the first run; for multiple iterations, stderr receives an aggregate finding count (`scripts/reproduce.py:105-112`, `scripts/reproduce.py:145-152`). The command returns 1 when any iteration has `is_crash`, 0 otherwise, and explicitly maps path or caught OS errors to 2 (`scripts/reproduce.py:118-121`, `scripts/reproduce.py:140-154`).

### `scripts/setup_v8.py`

- The CLI selects a work directory, branch or tag, debug/release configuration, job count, clobber policy, and whether compilation is skipped (`scripts/setup_v8.py:42-78`). Work-directory normalization expands and resolves the path, rejects non-directories, and applies additional containment and symlink checks when clobbering is enabled (`scripts/setup_v8.py:81-103`).
- `depot_tools` is cloned when absent or fetched and hard-reset when present; V8 is fetched only when its expected directory is absent, after which the requested branch is checked out and dependencies are synchronized (`scripts/setup_v8.py:124-166`).
- Dependency setup is platform-specific (`scripts/setup_v8.py:169-184`). GN arguments are written to `v8/out/{debug,release}`, then `gn gen` and `ninja ... d8` run unless compilation was skipped (`scripts/setup_v8.py:187-224`, `scripts/setup_v8.py:251-255`).
- Locate/report behavior computes the expected platform-specific binary under that fixed output directory and reports only whether the path exists (`scripts/setup_v8.py:227-237`). Command failures represented by `CalledProcessError` or `OSError` are reported and converted to exit status 1 (`scripts/setup_v8.py:257-264`).

## 2. Correctness & robustness

### `scripts/fuzz_gc.py`

- **CONFIRMED:** Corpus selection is verbatim replay: source and flags are copied from the selected `Seed`, with no mutation or crossover step on that branch (`scripts/fuzz_gc.py:198-205`).
- **CONFIRMED:** Seeds are not cached across iterations; `list(corpus.iter_seeds())` rematerializes the collection every time, and the progress count can lag an addition made later in the same iteration because it prints that earlier snapshot (`scripts/fuzz_gc.py:194-200`, `scripts/fuzz_gc.py:214-226`).
- **LIKELY:** Printing the campaign seed supports regeneration of fresh cases, but it does not by itself reproduce replay choices if corpus contents or enumeration order differ, because those choices are made from the live collection (`scripts/fuzz_gc.py:186-201`).
- **CONFIRMED:** The outer loop is bounded by a strictly positive iteration count, and the configured engine timeout is passed to `D8Wrapper` (`scripts/fuzz_gc.py:23-27`, `scripts/fuzz_gc.py:51-67`, `scripts/fuzz_gc.py:176-183`, `scripts/fuzz_gc.py:194`). The timeout itself accepts zero, negative, NaN, and infinite floats, and the generator subprocess has no timeout, so the script does not establish a finite end-to-end wall-clock bound (`scripts/fuzz_gc.py:63-67`, `scripts/fuzz_gc.py:94-95`).
- **CONFIRMED:** Generated flag headers are split on whitespace rather than with shell-style quoting, so a quoted or escaped multi-token value will not retain its grouping (`scripts/fuzz_gc.py:121-127`).
- **LIKELY:** Treating any missing engine path as dry-run mode can turn a path configuration error into a successful corpus-writing run rather than a startup error (`scripts/fuzz_gc.py:33-37`, `scripts/fuzz_gc.py:173-184`, `scripts/fuzz_gc.py:214-223`).
- **SPECULATIVE:** The actual engine timeout behavior and active-run seed persistence depend on `D8Wrapper` and `Harness`; this script only supplies the timeout and calls `evaluate` (`scripts/fuzz_gc.py:176-184`, `scripts/fuzz_gc.py:206-207`).

### `scripts/reproduce.py`

- **CONFIRMED:** Timeout input rejects non-finite and non-positive values, iteration input rejects non-positive integers, and both values are passed into bounded repeated execution (`scripts/reproduce.py:23-40`, `scripts/reproduce.py:79-89`, `scripts/reproduce.py:127-137`).
- **SPECULATIVE:** Enforcement details for each engine timeout remain dependency-bound because this file passes the value to `D8Wrapper` but contains no local timeout implementation (`scripts/reproduce.py:127-137`).
- **CONFIRMED:** Extra flags are parsed once with `shlex.split` and passed as an argument list, avoiding ad hoc whitespace parsing at this CLI boundary (`scripts/reproduce.py:43-47`, `scripts/reproduce.py:60-65`, `scripts/reproduce.py:123-137`).
- **CONFIRMED:** Exit status 1 means at least one `Detection.is_crash` was true; it is not computed directly from the engine process exit code or from the displayed class name (`scripts/reproduce.py:107-112`, `scripts/reproduce.py:136-154`).
- **CONFIRMED:** Multi-run output can conceal variation because only the first `Detection` receives detailed output even when a later run is the only finding; later results contribute only to the aggregate count (`scripts/reproduce.py:124-152`).
- **LIKELY:** Tool failures outside the caught `OSError` family will bypass the documented exit-status-2 mapping, because the execution block has no broader operational-error mapping (`scripts/reproduce.py:1-5`, `scripts/reproduce.py:126-143`).

### `scripts/setup_v8.py`

- **CONFIRMED:** The module description calls reruns idempotent updates, but the default path deletes the complete existing work directory; update behavior occurs only with `--no-clobber` (`scripts/setup_v8.py:11-13`, `scripts/setup_v8.py:68-72`, `scripts/setup_v8.py:243-249`).
- **CONFIRMED:** Existing `depot_tools` and V8 paths are recognized only by existence, not by repository/layout validation, so malformed or partial directories are handed to Git or depot commands and fail later (`scripts/setup_v8.py:124-143`, `scripts/setup_v8.py:146-165`).
- **LIKELY:** An existing V8 checkout that lacks the requested ref fails before synchronization can obtain it, because `git checkout <branch>` precedes `gclient sync` and there is no explicit V8 fetch (`scripts/setup_v8.py:158-165`).
- **CONFIRMED:** Linux dependency setup silently continues when the expected installer is absent, while the macOS installer command is issued unconditionally (`scripts/setup_v8.py:169-184`).
- **CONFIRMED:** External setup, synchronization, generation, and build commands have no timeout; `run` waits for each command and relies only on its exit status (`scripts/setup_v8.py:106-109`).
- **CONFIRMED:** `--skip-build` can return success while reporting `exists: False`, and a normal build is considered successful without checking executability or running a smoke test (`scripts/setup_v8.py:227-235`, `scripts/setup_v8.py:251-264`).
- **LIKELY:** Failed runs can leave partial checkouts or build outputs for a later `--no-clobber` run, because failures are converted to status 1 without cleanup or state validation (`scripts/setup_v8.py:243-262`).

## 3. Effectiveness/coverage gaps

### `scripts/fuzz_gc.py`

- The loop divides effort between unchanged corpus replay and fresh generation; it has no path that mutates a corpus case, combines two cases, or feeds a selected case back into generation (`scripts/fuzz_gc.py:194-205`).
- Replay probability is fixed at 50%, and the only periodic telemetry is corpus size plus selected identifier, leaving generated-versus-replayed counts and outcome rates unreported (`scripts/fuzz_gc.py:199-205`, `scripts/fuzz_gc.py:224-226`).
- Corpus enumeration is repeated on every iteration, while campaign control offers only an iteration bound and an engine timeout rather than a campaign deadline or generator timeout (`scripts/fuzz_gc.py:51-67`, `scripts/fuzz_gc.py:194-200`, `scripts/fuzz_gc.py:94-95`).

### `scripts/reproduce.py`

- Reproduction uses only CLI-provided flags and does not extract a `// Flags:` header from the testcase, so callers must separately preserve the original invocation settings (`scripts/reproduce.py:60-65`, `scripts/reproduce.py:123-137`).
- Repeated execution reports the first detailed result and one total, with no per-iteration class, stack hash, raw-output record, or structured output mode (`scripts/reproduce.py:105-112`, `scripts/reproduce.py:136-152`).
- Every run uses the same testcase stem as `seed_id`, so the CLI provides no distinct per-run identifier for downstream records (`scripts/reproduce.py:135-140`).

### `scripts/setup_v8.py`

- Build configuration exposes only debug/release selection and a fixed GN argument set; it has no CLI profiles for assertion level, instrumentation, architecture, or coverage-oriented variants (`scripts/setup_v8.py:57-61`, `scripts/setup_v8.py:187-205`).
- The default tracks `main`, and the summary does not report a resolved source revision or the effective GN configuration, limiting build provenance (`scripts/setup_v8.py:50-55`, `scripts/setup_v8.py:227-237`).
- Binary discovery is limited to the single derived `out/<build-type>/d8` path and an existence check; it does not locate other existing output directories or validate runtime behavior (`scripts/setup_v8.py:187-190`, `scripts/setup_v8.py:227-237`).

## 4. Prioritized improvement list

1. Add corpus mutation and crossover stages, with configurable replay/generation ratios and per-stage outcome counters (`scripts/fuzz_gc.py:194-226`).
2. Make checkout reuse the default, require an explicit clobber request, and validate expected repository layouts before update or deletion (`scripts/setup_v8.py:68-72`, `scripts/setup_v8.py:124-165`, `scripts/setup_v8.py:243-249`).
3. Accept a pinned revision, fetch before checkout, and emit a provenance manifest containing revision, platform, and effective GN arguments (`scripts/setup_v8.py:50-60`, `scripts/setup_v8.py:158-165`, `scripts/setup_v8.py:194-205`, `scripts/setup_v8.py:227-237`).
4. Validate the GC-loop timeout as finite and positive, add a generator timeout, and optionally enforce a campaign deadline (`scripts/fuzz_gc.py:51-67`, `scripts/fuzz_gc.py:94-95`, `scripts/fuzz_gc.py:194`).
5. Maintain an incrementally updated in-memory seed index instead of rematerializing the corpus on every iteration (`scripts/fuzz_gc.py:194-223`).
6. Let reproduction load embedded flags and emit every iteration's classification in a structured format while retaining the aggregate exit contract (`scripts/reproduce.py:60-65`, `scripts/reproduce.py:105-112`, `scripts/reproduce.py:135-154`).
7. Add named build profiles and verify the resulting binary with executable and smoke checks before reporting build success (`scripts/setup_v8.py:57-61`, `scripts/setup_v8.py:187-205`, `scripts/setup_v8.py:227-235`).
