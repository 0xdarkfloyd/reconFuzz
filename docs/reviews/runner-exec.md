# Execution Backend Review

Scope: dry source review of `src/runner/d8_wrapper.py`, `src/runner/reprl.py`, and
`src/runner/harness.py` only.

## 1. Structure Map

### D8Wrapper and D8Result

- `D8Result` is the common result record: process-style `returncode`, separate
  `stdout` and `stderr`, `timed_out`, elapsed milliseconds, and optional
  `coverage_hash`, `edge_count`, and raw `coverage_bitmap` fields
  (`src/runner/d8_wrapper.py:53-67`).
- `D8Wrapper.run` combines default, coverage, and per-testcase flags; writes the
  source to a temporary file; starts one engine-shell process; and uses
  `communicate()` to collect both output streams (`src/runner/d8_wrapper.py:146-163`,
  `src/runner/d8_wrapper.py:185-207`).
- The textual channel combines stdout, stderr, and an auto-created LCOV file,
  then hashes recognized `DA`, `FNDA`, bare-PC, edge, block, counter, or PC lines
  (`src/runner/d8_wrapper.py:115-144`, `src/runner/d8_wrapper.py:165-172`,
  `src/runner/d8_wrapper.py:209-223`).
- The Fuzzilli channel creates a fresh 2 MiB shared-memory segment, exports its
  name through `SHM_ID`, validates the edge-count header, copies the used bitmap,
  hashes it, and counts set bits (`src/runner/d8_wrapper.py:20-26`,
  `src/runner/d8_wrapper.py:174-183`, `src/runner/d8_wrapper.py:243-266`).

### ReprlRunner lifecycle

1. Construction allocates one persistent coverage segment, initializes PID/FD
   sentinels, and calls `_spawn`; a construction failure calls `close`
   (`src/runner/reprl.py:63-91`).
2. `_spawn` closes prior parent FDs, creates four pipes, forks, relocates child
   pipe ends to REPRL FDs 100-103, merges child stdout/stderr onto the data pipe,
   and execs the engine shell with fixed startup flags and `SHM_ID`
   (`src/runner/reprl.py:95-139`, `src/runner/reprl.py:141-179`).
3. The parent records its four pipe ends, drains startup output while awaiting
   `HELO`, returns `HELO`, validates the bitmap header, and preallocates the
   per-run zero buffer (`src/runner/reprl.py:183-214`).
4. `run` checks liveness and respawns when necessary, clears the used bitmap,
   writes `exec`, the little-endian source length, and source bytes, then waits
   for a four-byte status while draining output (`src/runner/reprl.py:218-250`,
   `src/runner/reprl.py:341-422`).
5. A complete status is decoded, after which the used bitmap is copied, hashed,
   and popcounted; stdout remains empty because the two child streams share the
   captured data pipe (`src/runner/reprl.py:252-265`, `src/runner/reprl.py:162-163`).
6. A timeout kills and reaps the child, drains remaining output, and attempts a
   respawn; an incomplete status follows the analogous crash-result path while
   retaining the wait status when available (`src/runner/reprl.py:424-466`,
   `src/runner/reprl.py:480-487`).
7. `close` sends `SIGTERM`, reaps, closes parent FDs, and closes/unlinks shared
   memory; `__del__` invokes that path as best-effort finalization
   (`src/runner/reprl.py:269-282`, `src/runner/reprl.py:489-493`).

### Harness

- `Harness` does not construct or choose a backend in this file; its constructor
  receives either a `D8Wrapper` or `ReprlRunner` and stores it, so runner
  selection is dependency-injected by the caller (`src/runner/harness.py:15-26`).
- `run_source` validates source and flags, normalizes string flags with
  `shlex.split`, calls the selected runner, sends successful runner results to
  the detector, and copies coverage plus normalized flags into the returned
  `Seed` (`src/runner/harness.py:28-51`, `src/runner/harness.py:68-83`).
- Backend `TimeoutExpired` and `OSError` exceptions are converted to non-crash
  timeout or unknown detections; other exception classes propagate
  (`src/runner/harness.py:48-69`).

## 2. Correctness and Robustness

- **CONFIRMED:** The normal one-shot path reaps the direct child through
  `communicate`; its timeout path kills the recursively enumerated children and
  parent before a second `communicate`; a `finally` removes source/LCOV files and
  closes/unlinks shared memory (`src/runner/d8_wrapper.py:198-207`,
  `src/runner/d8_wrapper.py:235-241`).
- **LIKELY:** One-shot timeout cleanup has a race between `TimeoutExpired` and
  `psutil.Process(proc.pid)`, and descendant cleanup is a point-in-time process
  tree walk rather than process-group termination. An exception or a newly
  created descendant in that interval can bypass the final `communicate` or the
  child list, weakening the no-orphan guarantee (`src/runner/d8_wrapper.py:201-207`).
- **CONFIRMED:** REPRL closes stale parent FDs before every spawn and releases
  FDs plus shared memory in `close`; initialization also unwinds through
  `close`, which covers the main FD and shared-memory leak paths
  (`src/runner/reprl.py:77-91`, `src/runner/reprl.py:95-120`,
  `src/runner/reprl.py:269-282`).
- **LIKELY:** REPRL has no deterministic owner-facing context-manager or
  `atexit` hook in the scoped lifecycle; callers that omit `close` depend on the
  best-effort finalizer, so interpreter shutdown or abrupt parent termination can
  leave the child or segment cleanup to the operating system
  (`src/runner/reprl.py:269-282`, `src/runner/reprl.py:489-493`).
- **CONFIRMED:** Graceful close sends `SIGTERM` and immediately performs a
  blocking `waitpid` with no deadline or `SIGKILL` escalation, so an engine child
  that does not terminate can block shutdown indefinitely
  (`src/runner/reprl.py:269-276`, `src/runner/reprl.py:299-309`).
- **CONFIRMED:** The REPRL execution timeout begins only after all three blocking
  writes finish. A stalled child or an oversized source can therefore block in
  `_write_all` without reaching `_read_status_and_output` and without enforcing
  `timeout_seconds` end to end (`src/runner/reprl.py:225-245`,
  `src/runner/reprl.py:311-321`, `src/runner/reprl.py:355-387`).
- **LIKELY:** `_crash_result` assumes an `OSError` during request writing means
  the child is already waitable, but it calls blocking `_reap`; a live child that
  closed only the protocol read end could stall this recovery path
  (`src/runner/reprl.py:237-243`, `src/runner/reprl.py:299-309`,
  `src/runner/reprl.py:444-454`).
- **CONFIRMED:** Spawn cleanup is not fully transactional after the PID/FD fields
  are installed. A failed parent `HELO` acknowledgement at `_write_all` skips the
  explicit handshake-failure cleanup; later respawn callers catch that
  `OSError` and return or continue, potentially retaining a half-initialized
  child and its FDs (`src/runner/reprl.py:189-203`,
  `src/runner/reprl.py:228-232`, `src/runner/reprl.py:424-454`).
- **CONFIRMED:** REPRL classifies status deadline expiry as `timed_out=True` with
  return code `-9`; EOF/short status as a crash-shaped result with the wait code
  or `-1`; and a complete status as a normal result carrying the decoded REPRL
  code (`src/runner/reprl.py:245-265`, `src/runner/reprl.py:424-466`).
- **CONFIRMED:** A control-pipe/select `OSError` is returned as a partial status
  and consequently follows the crash path, while a respawn failure returns
  `-1` with `timed_out=False`. Backend transport failure and child termination
  are therefore not represented as distinct result kinds
  (`src/runner/reprl.py:381-397`, `src/runner/reprl.py:228-250`,
  `src/runner/reprl.py:468-478`).
- **CONFIRMED:** `_alive` nonblockingly reaps a child that died between runs, and
  the next call respawns before clearing or using the bitmap; timeout and crash
  handlers also attempt an immediate respawn (`src/runner/reprl.py:228-235`,
  `src/runner/reprl.py:286-309`, `src/runner/reprl.py:424-454`).
- **LIKELY:** Bitmap coverage is stable with respect to counter magnitude because
  both runners hash a binary edge set, with fresh zero-filled memory in one-shot
  mode and an explicit used-region clear in REPRL mode. It can still vary when
  the executed edge set itself is nondeterministic (`src/runner/d8_wrapper.py:174-183`,
  `src/runner/d8_wrapper.py:262-266`, `src/runner/reprl.py:234-255`).
- **LIKELY:** Textual signatures are more jitter-prone because recognized LCOV
  and generic counter lines are hashed verbatim, including execution counts and
  input ordering; repeated executions with equal edge presence but differing
  counts can produce different hashes (`src/runner/d8_wrapper.py:124-143`).
- **SPECULATIVE:** The 16-hex-character SHA-256 prefixes can collide at very large
  corpus scales; the raw bitmap retained in `D8Result` permits exact comparison
  where the downstream implementation elects to use it
  (`src/runner/d8_wrapper.py:62-67`, `src/runner/d8_wrapper.py:264-266`,
  `src/runner/reprl.py:252-264`).
- **CONFIRMED:** Per-testcase flags are appended in one-shot mode but explicitly
  discarded in REPRL mode. `Harness` nevertheless persists those normalized
  flags in `Seed`, so a REPRL seed can record flags that were not applied to its
  execution (`src/runner/d8_wrapper.py:152-157`, `src/runner/reprl.py:218-225`,
  `src/runner/harness.py:38-51`, `src/runner/harness.py:73-81`).

## 3. Coverage and Performance Gaps

- One-shot mode supports either shared-memory edge coverage or textual coverage;
  when coverage flags are configured without shared memory and no `--lcov=` flag
  exists, it adds and reads a temporary LCOV file (`src/runner/d8_wrapper.py:165-187`,
  `src/runner/d8_wrapper.py:209-223`).
- An explicit `--lcov=PATH` suppresses temporary-file creation, but that path is
  not read by the wrapper; unless records also appear on stdout/stderr, the LCOV
  channel yields no signature (`src/runner/d8_wrapper.py:165-172`,
  `src/runner/d8_wrapper.py:209-223`).
- Text parsing includes `DA` and `FNDA` but not LCOV `BRDA`; it also accepts broad
  free-form counter lines, so branch coverage can be omitted while unrelated
  matching diagnostics can enter the hash (`src/runner/d8_wrapper.py:124-143`).
- Shared-memory mode has no textual fallback when the bitmap header is missing or
  invalid, and timed-out executions intentionally return no coverage even if the
  child set some bits before termination (`src/runner/d8_wrapper.py:219-223`,
  `src/runner/d8_wrapper.py:249-265`).
- REPRL exposes only the shared-memory channel: its constructor has no coverage
  flag/channel parameter, the bitmap is mandatory at handshake, and per-case
  flags are ignored (`src/runner/reprl.py:63-75`, `src/runner/reprl.py:205-224`).
- REPRL's primary throughput gains are one engine initialization, one shared
  segment, and pipe-based source delivery across many cases; one-shot mode pays
  process startup, temporary-source creation, and possibly shared-memory or LCOV
  setup for every case (`src/runner/reprl.py:54-60`, `src/runner/reprl.py:77-86`,
  `src/runner/reprl.py:234-245`, `src/runner/d8_wrapper.py:159-196`).
- REPRL still clears, copies, hashes, and popcounts the full used bitmap on every
  successful case, making coverage-map size a linear per-case cost
  (`src/runner/reprl.py:205-214`, `src/runner/reprl.py:234-255`).
- Concurrent status/output draining avoids pipe-capacity deadlock and caps
  retained output at 16 MiB, but stdout and stderr lose channel identity
  (`src/runner/reprl.py:50-51`, `src/runner/reprl.py:341-422`,
  `src/runner/reprl.py:256-264`).
- The process backend honors per-case flags and preserves stream separation at
  the cost of startup overhead; REPRL improves steady-state throughput but fixes
  flags at startup and makes child recovery part of the normal long-running
  lifecycle (`src/runner/d8_wrapper.py:146-157`, `src/runner/d8_wrapper.py:185-207`,
  `src/runner/reprl.py:54-60`, `src/runner/reprl.py:424-454`).

## 4. Prioritized Improvements

1. Enforce one monotonic REPRL deadline across request writes and response reads,
   using readiness-based writes and a source-size bound, to eliminate hangs
   outside `timeout_seconds` (`src/runner/reprl.py:225-245`, `src/runner/reprl.py:311-321`).
2. Make `_spawn` transactional after `fork`: on every handshake, validation, or
   acknowledgement error, kill/reap the new PID and close every new FD before
   returning (`src/runner/reprl.py:183-214`, `src/runner/reprl.py:228-232`).
3. Give `close` a bounded `SIGTERM` grace period followed by `SIGKILL`, and add
   explicit context-manager/owner cleanup so shutdown does not depend on
   `__del__` (`src/runner/reprl.py:269-282`, `src/runner/reprl.py:489-493`).
4. Preserve flag truthfulness by routing flag-bearing cases to one-shot mode or
   pooling REPRL children by startup-flag tuple, and persist only the flags that
   actually ran (`src/runner/reprl.py:218-225`, `src/runner/harness.py:73-81`).
5. Introduce an explicit backend outcome kind for normal exit, timeout, child
   death, and transport/respawn failure instead of overloading negative return
   codes (`src/runner/reprl.py:245-265`, `src/runner/reprl.py:424-478`).
6. Harden one-shot termination with a dedicated process group and race-tolerant
   reap logic so timeout cleanup covers descendants and always waits for the
   direct child (`src/runner/d8_wrapper.py:189-207`).
7. Parse the configured LCOV artifact structurally, include branch records, and
   normalize count-bearing records to the intended coverage semantics to reduce
   signature gaps and jitter (`src/runner/d8_wrapper.py:115-144`,
   `src/runner/d8_wrapper.py:165-223`).
8. Measure bitmap clear/copy/hash/popcount cost and, if material, fuse passes or
   expose changed-word information from the coverage producer to reduce the
   linear steady-state overhead (`src/runner/reprl.py:234-255`).
