# Python Test-Suite Quality and Coverage Review

Scope: `tests/test_runner.py` mapped against `src/runner/*.py` and `scripts/*.py`.
The labels below use **TESTED** when the principal public mechanism has direct
behavioral assertions, **PARTIAL** when only helpers or conditional integration
paths are exercised, and **UNTESTED** when the suite has no direct behavioral
test. **TESTED** does not mean exhaustive.

## 1. Coverage Map

### `src/runner`

- **PARTIAL - `d8_wrapper.py`.** Text coverage hashing is checked for path
  independence and count sensitivity, a `/bin/true` run checks that source
  identity is not treated as coverage, and the older-Python shared-memory
  constructor fallback is asserted (`tests/test_runner.py:1155-1197`). A real
  shared-memory execution check exists, but it is skipped unless one hard-coded
  binary is present (`tests/test_runner.py:1298-1325`). No deterministic test
  drives process timeout and descendant cleanup, command/flag construction,
  temporary LCOV handling, launch failure cleanup, or the invalid/edge-boundary
  branches of `_read_shmem_bitmap`; the direct checks stop at the paths above
  (`tests/test_runner.py:1155-1197`, `tests/test_runner.py:1301-1325`).

- **PARTIAL - `reprl.py`.** Bitmap sizing is checked; optional integration tests
  cover normal execution, abnormal-child recovery, repeated respawn, and FD
  growth; unit tests cover parent-FD closure, pre-spawn cleanup, terminating
  signal retention, output deadline, and capture truncation
  (`tests/test_runner.py:1200-1212`, `tests/test_runner.py:1328-1546`). Thus
  respawn and abnormal-child paths do have direct tests, contrary to a possible
  high-level reading of the suite, but the most realistic ones are conditional
  on an external binary (`tests/test_runner.py:1298-1302`,
  `tests/test_runner.py:1339-1401`). There are no direct assertions for handshake
  failure cleanup, request-write timeout, `_alive`, `_reap`, `_timeout_result`,
  `_dead_result`, `_kill_and_reap`, complete `close()` cleanup, or shared-memory
  unlinking (`tests/test_runner.py:1404-1546`).

- **TESTED - `harness.py`.** Tests cover result-to-seed coverage propagation,
  evaluation with and without a corpus, routing by detection result, defensive
  flag copying and splitting, timeout and missing-runner conversion, source type
  validation, and deterministic/explicit IDs (`tests/test_runner.py:1005-1152`).
  Coverage-bitmap propagation and invalid flag container/element shapes remain
  unasserted; the existing propagation check covers only `coverage_hash`
  (`tests/test_runner.py:1005-1012`, `tests/test_runner.py:1067-1137`).

- **TESTED - `detector.py`.** Direct cases cover native-exit gating, sanitizer
  channel and exit behavior, timeout consistency, two benign flag-processing
  diagnostics, current CHECK/DCHECK/unreachable/signal forms, stackless
  separation, and address-independent symbolized hashes
  (`tests/test_runner.py:884-1002`). Pattern entries for assertion, null access,
  use-after-free, buffer overflow, sandbox violation, stack overflow, generic
  fatal error, harmless-error markers, and several fallback signal strings have
  no dedicated case in the parameter tables shown there
  (`tests/test_runner.py:884-1002`).

- **TESTED - `corpus_manager.py`.** The suite directly checks basic persistence
  and duplicate rejection, external-directory import/reload, coverage-hash
  admission, sequential ID collision handling, abnormal-result dedup across a
  restart, malformed metadata tolerance, coverage-gain subset rejection,
  hash fallback, union persistence, and admission rollback after a metadata
  write failure (`tests/test_runner.py:238-251`, `tests/test_runner.py:430-446`,
  `tests/test_runner.py:838-881`, `tests/test_runner.py:1244-1295`). `Seed.energy`
  round-trip semantics, `clear()`, invalid admission configuration,
  `manage_union=False`, truncated union files, and concurrent writers have no
  direct assertion (`tests/test_runner.py:238-251`,
  `tests/test_runner.py:838-881`, `tests/test_runner.py:1244-1295`).

- **TESTED - `scheduler.py`.** Configuration validation, default values,
  abnormal-result and coverage bonuses, negative depth rejection, empty input,
  endpoint fallback, and injected-RNG repeatability are covered
  (`tests/test_runner.py:254-344`). Positive depth contribution, relative
  selection weights, statistical boundaries, and persisted `Seed.energy` are
  not asserted; all selection examples use default-energy seeds and only one or
  two RNG points (`tests/test_runner.py:254-269`,
  `tests/test_runner.py:299-344`).

- **PARTIAL - `coverage_union.py`.** Tests assert shared-memory size, sequential
  first-admission/duplicate behavior, payload-only save format, and restoration
  (`tests/test_runner.py:1200-1232`). There is no multiprocess `attach()` test,
  no simultaneous update of different bits in the same byte, no monotonicity
  stress test, and no direct test for oversize input, unavailable buffers,
  throttled saves, failed persistence, or close/unlink idempotence
  (`tests/test_runner.py:1200-1232`).

### `scripts`

- **PARTIAL - `fuzz.py`.** The suite imports only the three HTTP helpers and
  directly exercises only malformed-body failure behavior: generation raises,
  while mutation and crossover return their input unchanged
  (`tests/test_runner.py:21`, `tests/test_runner.py:1549-1564`). Successful HTTP
  requests, CLI validation, flag helpers, worker initialization and shutdown,
  worker replay/generation/admission branches, YAML scheduler construction,
  daemon restart, executor accounting, parent-only persistence, coverage-union
  lifecycle, interrupt handling, and the end-to-end loop have no direct tests
  (`tests/test_runner.py:21`, `tests/test_runner.py:1549-1564`).

- **UNTESTED - `fuzz_gc.py`.** The runner test module's complete script import
  block includes `fuzz`, `import_corpus`, and `reproduce`, but not `fuzz_gc`, and
  no later test references it (`tests/test_runner.py:19-26`,
  `tests/test_runner.py:1549-1564`). Generator subprocess handling, flag
  extraction, child cleanup, replay selection, dry-run behavior, and the main
  loop therefore have no direct coverage in this suite
  (`tests/test_runner.py:19-30`, `tests/test_runner.py:1549-1564`).

- **TESTED - `import_corpus.py`.** Parser normalization, flag extraction, HTTP
  lift request/response and URL failure, normalized import, quarantine,
  unreachable-daemon fallback, verbatim import without a daemon, per-seed error
  isolation, stable safe IDs, dry run, limit, invalid source, and repeat-import
  reporting are all asserted (`tests/test_runner.py:449-835`).

- **TESTED - `reproduce.py`.** Positive numeric parsing, path validation, CLI
  error statuses, quoted flags, default directories, timeout/iteration
  validation, result formatting, repeated evaluation count, and final status
  are tested (`tests/test_runner.py:33-227`, `tests/test_runner.py:347-427`). The
  successful CLI paths replace both wrapper and harness, so they validate script
  orchestration rather than integration with the real runner stack
  (`tests/test_runner.py:119-227`).

- **UNTESTED - `setup_v8.py`.** It is absent from the script imports and from all
  direct test calls (`tests/test_runner.py:19-30`). Argument safety, platform
  command selection, checkout/update command sequences, GN file content, build
  invocation, summary validation, and error-to-status mapping have no coverage
  in this suite (`tests/test_runner.py:19-30`,
  `tests/test_runner.py:1549-1598`).

## 2. Weak / Shallow Assertions

- The basic scheduler selection test checks only that the returned ID starts
  with `seed-`; it would accept a newly fabricated seed or a fixed eligible-
  looking ID rather than prove membership in the input sequence
  (`tests/test_runner.py:254-269`).

- The injected-RNG test asserts only that two schedulers return the same object.
  An implementation that always selects the first seed would pass, even though
  the second seed carries a coverage bonus and weighted selection is the behavior
  of interest (`tests/test_runner.py:335-344`).

- Scheduler energy assertions cover base, abnormal-result, and coverage bonuses,
  but the sole depth test is an error case. Removing the positive
  `depth * depth_bonus` contribution would not fail the suite
  (`tests/test_runner.py:272-314`).

- The first corpus duplicate test submits the same `Seed` object twice and
  checks only the retained source. An implementation deduplicating by object or
  source identity could satisfy that test without honoring the intended
  class/stack fallback key (`tests/test_runner.py:238-251`). Later coverage and
  abnormal-result tests strengthen other dedup modes, but do not replace a
  distinct-object test for this fallback (`tests/test_runner.py:838-868`).

- The symbolized-stack test compares two renderings of the same frame but never
  compares different frames. A constant `_stack_hash` would satisfy this
  equality assertion (`tests/test_runner.py:990-1002`).

- The two harness routing tests assert only that some `meta.json` exists in the
  expected directory and none exists in the other. They do not verify persisted
  source, flags, class, stack hash, or ID, so malformed metadata can still pass
  (`tests/test_runner.py:1041-1064`).

- The one-shot wrapper check uses `/bin/true` and expects no coverage. A wrapper
  that always returns `coverage_hash=None` passes this check; only the optional
  external-binary test can then demonstrate shared-memory coverage collection
  (`tests/test_runner.py:1170-1174`, `tests/test_runner.py:1301-1325`).

- The fuzz daemon-helper test exercises only malformed decoding. Mutation and
  crossover are expected to return the original source, so helpers permanently
  implemented as passthroughs would pass; generation has no successful request
  assertion either (`tests/test_runner.py:1549-1564`).

- The REPRL terminating-signal test replaces `_spawn` with a no-op and asserts
  only the returned signal code. It does not prove respawn, reaping, FD closure,
  or shared-memory cleanup (`tests/test_runner.py:1474-1497`).

- The import limit test asserts only that two records exist, not which two were
  selected or whether traversal order is deterministic
  (`tests/test_runner.py:759-783`).

## 3. Missing Property / Invariant Tests

The following should be expressed as repeatable property or lifecycle tests:

- **Coverage-union monotonicity under concurrency:** after attached worker
  processes update overlapping and disjoint bits, the final bitmap equals the
  bitwise OR of every submitted bitmap; once set, a bit never clears. Current
  tests perform only sequential updates (`tests/test_runner.py:1200-1232`).

- **Concurrent gain admission:** simultaneous candidates sharing the same new
  edge admit at most the documented number of records, and simultaneous
  candidates setting different bits in one byte never lose either bit. No test
  creates two union attachments or coordinates workers at one update point
  (`tests/test_runner.py:1200-1232`).

- **Corpus ID uniqueness and non-overwrite:** across multiple manager instances
  writing the same requested ID concurrently, every distinct accepted record
  has a unique directory and retains its own source and metadata. The current
  collision test is sequential and inspects only names plus one metadata ID
  (`tests/test_runner.py:849-857`).

- **Scheduler selection closure:** for every non-empty input and valid
  configuration/RNG output, `select()` returns the identical object of one input
  element and never a record outside the input. Current checks cover one ID
  prefix, one endpoint, and one repeated RNG seed (`tests/test_runner.py:254-269`,
  `tests/test_runner.py:322-344`).

- **Persisted-energy contract:** a non-default `Seed.energy` survives corpus
  reload and affects selection weight according to the scheduler contract.
  Existing scheduler selection cases never set `energy`, and corpus reload tests
  do not assert it (`tests/test_runner.py:254-269`,
  `tests/test_runner.py:430-446`, `tests/test_runner.py:335-344`).

- **REPRL termination cleanup:** after `close()` or a SIGTERM-driven worker
  shutdown, the child is wait-reaped, all four parent FDs are closed, and the
  named shared-memory segment is no longer attachable. Existing tests isolate FD
  helper behavior or stub respawn and do not assert the full lifecycle
  (`tests/test_runner.py:1328-1336`, `tests/test_runner.py:1404-1497`).

- **REPRL per-run isolation:** a second execution's bitmap and output contain no
  bits or bytes retained solely from the first execution, including after a
  timeout and respawn. The integration case checks that two executions both
  have coverage but not that state was cleared between them
  (`tests/test_runner.py:1340-1350`).

- **One-shot cleanup on every exit:** success, timeout, launch error, coverage
  read error, and process-tree enumeration error all remove the source/LCOV
  files, close/unlink shared memory, and leave no child process. Current direct
  one-shot test covers only successful `/bin/true` execution
  (`tests/test_runner.py:1170-1174`).

- **Transactional corpus visibility:** a failed source or metadata write leaves
  either no entry or one complete readable entry, never a partial directory that
  consumes an ID. The current failure test verifies admission can be retried but
  explicitly accepts the retry under the suffixed ID `a_1`
  (`tests/test_runner.py:1274-1295`).

- **Stack-hash discrimination:** equivalent frames with different addresses hash
  equally, while different top frames hash differently. Only the equality half
  exists for symbolized stacks (`tests/test_runner.py:990-1002`).

- **Fuzz-loop accounting and ownership:** for finite runs, every configured
  successful evaluation is counted once; each accepted seed is persisted only
  by the parent; worker errors replenish work according to the documented
  iteration contract; daemon/executor/union resources close on normal,
  interrupt, and exception exits. No `fuzz.main` or worker lifecycle test exists
  (`tests/test_runner.py:21`, `tests/test_runner.py:1549-1564`).

Two suggested invariants are already present and should not be counted as gaps:
gain admission rejects a bitmap that is a subset of the union
(`tests/test_runner.py:1244-1255`), and import quarantine plus verbatim behavior
without `--daemon` are asserted (`tests/test_runner.py:547-596`,
`tests/test_runner.py:631-662`). Their missing extension is concurrency for the
former and malformed-response/quarantine-write behavior for the latter.

## 4. Fragile / Flaky Tests

- Four execution-backend tests depend on a binary at the fixed path
  `~/v8/v8/out/fuzzbuild/d8` and are skipped when it is absent, so their coverage
  varies by developer and CI host (`tests/test_runner.py:1298-1305`,
  `tests/test_runner.py:1339-1374`). The repeated-respawn test shares the same
  condition (`tests/test_runner.py:1373-1401`).

- The real shared-memory coverage test uses fixed jitter and signal thresholds.
  Runtime background activity or a changed instrumented build can violate
  `jitter < 500` or the 10x ratio without a wrapper regression
  (`tests/test_runner.py:1314-1325`).

- The FD-growth test depends on Linux `/proc/self/fd`, assumes incidental FD
  allocation stays within one descriptor, and also exercises an external
  binary repeatedly (`tests/test_runner.py:1374-1397`).

- Several REPRL unit tests require POSIX `os.pipe`, `os.fork`, signals, and
  `waitpid` semantics, making them platform-specific rather than portable pytest
  units (`tests/test_runner.py:1404-1497`).

- The output-drain test uses a live writer thread and wall-clock bounds: a
  50-millisecond deadline must complete within 500 milliseconds. A heavily
  loaded host can fail the timing assertion or delay thread shutdown
  (`tests/test_runner.py:1500-1546`).

- The one-shot wrapper test assumes `/bin/true` exists and is executable, which
  is a Unix-host dependency (`tests/test_runner.py:1155-1174`).

- The `tmp_path` tests use per-test isolation and do not intentionally depend on
  a path race; the only concurrency-oriented temporary-resource case uses a
  thread around pipes rather than competing filesystem writers
  (`tests/test_runner.py:1500-1546`). Likewise, direct HTTP tests patch
  `urlopen`, so this suite has no unstubbed network dependency
  (`tests/test_runner.py:461-497`, `tests/test_runner.py:523-523`,
  `tests/test_runner.py:608-608`, `tests/test_runner.py:1560-1564`).

## 5. Prioritized New-Test List

1. Add a barrier-synchronized multiprocess `CoverageUnion.attach()` test that
   verifies exact OR, no lost same-byte bits, monotonicity, and duplicate
   admission (`tests/test_runner.py:1200-1232`).
2. Add a fully stubbed `fuzz.main` orchestration test for finite accounting,
   parent-only persistence, daemon restart, union snapshots, and cleanup across
   normal/error/interrupt exits (`tests/test_runner.py:21`,
   `tests/test_runner.py:1549-1564`).
3. Add a deterministic fake-REPRL child fixture covering handshake failure,
   short writes/status, timeout, respawn, reaping, FD closure, and shared-memory
   unlink without the external binary (`tests/test_runner.py:1328-1546`).
4. Add mocked-`Popen` one-shot tests for flags, LCOV ingestion, timeout process-
   tree cleanup, launch failure, and temporary/shared-memory cleanup
   (`tests/test_runner.py:1155-1197`).
5. Add concurrent `CorpusManager` writer tests that assert unique IDs, exact
   source/metadata preservation, and no partially visible entries
   (`tests/test_runner.py:849-857`, `tests/test_runner.py:1274-1295`).
6. Add scheduler properties for input membership, positive depth energy,
   boundary RNG points, relative weights, and persisted non-default energy
   (`tests/test_runner.py:254-344`).
7. Add a branch-table test for `worker_task`, `_maybe_admit`, worker setup, and
   successful generate/mutate/crossover requests, including request method,
   URL, body, flags, and replay fallback (`tests/test_runner.py:21`,
   `tests/test_runner.py:1549-1564`).
8. Add coverage-union oversize, attach/close, legacy-file, throttled-save, and
   persistence-failure cases (`tests/test_runner.py:1200-1232`).
9. Add detector table cases for every currently unrepresented diagnostic class
   and assert different symbolized frames produce different hashes
   (`tests/test_runner.py:884-1002`).
10. Add `fuzz_gc.py` tests for generator command/error/temp cleanup, flag
    extraction, deterministic seed progression, replay selection, dry run, and
    child cleanup (`tests/test_runner.py:19-30`).
11. Add `setup_v8.py` parser and platform-command tests with all subprocesses
    stubbed, including GN content, skip-build, clobber guards, and error status
    (`tests/test_runner.py:19-30`).
12. Extend import tests with malformed lift schemas, quarantine write failure,
    deterministic limit selection, and dry-run quarantine behavior
    (`tests/test_runner.py:547-596`, `tests/test_runner.py:731-783`).
13. Add one script-level test using a tiny executable fixture through the real
    wrapper, detector, harness, and corpus stack to complement the mocked
    successful `reproduce.py` paths (`tests/test_runner.py:119-227`).
