# reconFuzz improvement backlog

Reconciled from the 8 codex file-by-file reviews in `docs/reviews/*.md` (all
codex-authored, attempt-1, neutral-framing, no guardrail trips). Grouped:
**A. Correctness** (invalid output / silent semantics / inert components / races),
**B. Effectiveness / feedback-loop**, **C. Coverage / ES support**. Each item:
file:line · severity · fix sketch. Drive codex implementations top-down; serialize
build-gated fixes (npm or pytest) to avoid build races.

## A. Correctness (fix first — these block real coverage)
- **A1 Printer: hashbang displacement** — `src/generator/printer.ts:34-42,75-81` · HIGH ·
  `// Flags:` + includes emitted before program text push `#!` off byte zero → invalid JS.
  Fix: emit interpreter/hashbang first, then flags header, then includes, then body.
- **A2 Printer: directive prologue lost** — `printer.ts:38-42,75-81` · HIGH · helper includes
  precede the program so `"use strict"` leaves the directive prologue (silent semantics change)
  whenever includes are present. Fix: keep program directives before any include line.
- **A3 Hybrid reconstruction drops metadata** — `src/generator/index.ts:154-160` · HIGH · hybrid
  merges only the three `body` arrays; directives/interpreter/sourceType are discarded. Fix:
  preserve directives + interpreter + sourceType from constituents.
- **A4 Wasm builder: no terminal `end` / no immediate validation** — `src/generator/wasm-builder.ts:36,408,420` ·
  HIGH · only load/store arity checked; malformed constants/calls/call_indirect/locals/globals pass;
  no appended `end`. Fix: append `end`; validate immediate counts/ranges.
- **A5 Wasm builder: memory index-space bug** — `wasm-builder.ts:163,170,206,286` · HIGH · `addMemory`
  counts locals but imports accepted after locals → local index ≠ combined index space (functions
  get this right; memories don't). Fix: correct index accounting; reject mixed ordering or reindex.
- **A6 Wasm builder: silent input coercion** — `wasm-builder.ts:473,477,488` · MED · writeU8 masks,
  writeU32 `>>>0`, writeI32 `|0`; negative/fractional/non-finite inputs encode as wrong values.
  Fix: validate or throw on bad inputs.
- **A7 SAB wait/notify mismatch (inert template)** — `src/generator/gc-templates.ts:473,495,511,533` ·
  HIGH · `Atomics.waitAsync` waits on i32 (sab) but `notify` targets i32_2 (sab2); never pairs;
  async result discarded, no timeout. Fix: pair on the same buffer; await/handle the async result.
- **A8 coverage_union lost-update race** — `src/runner/coverage_union.py:86` · HIGH · `buf[i] |= byte`
  unsynchronized RMW → lost edges, violates monotonic invariant, corrupts gain admission + persisted
  union. Fix: atomic bit-set (e.g. per-byte CAS or lock, or byte-granular atomic OR).
- **A9 REPRL timeout not end-to-end + close() no SIGKILL** — `src/runner/reprl.py:225-245,269-276,311-321` ·
  HIGH · deadline starts after blocking writes; `close()` waitpids with no deadline/SIGKILL. Fix: wrap
  the whole request in the deadline; escalate SIGTERM→SIGKILL on close.
- **A10 REPRL flags dropped but persisted** — `reprl.py:218-225`, `src/runner/harness.py:73-81` · MED ·
  testcase flags discarded under REPRL but recorded into the Seed → advertises flags that never ran.
  Fix: route flag-bearing cases to one-shot, or pool REPRL children by startup-flag tuple.

## A-EOE. End-to-end findings (from codex E2E runs, docs/reviews/e2e-*.md)
- **E1 gc-only/hybrid "runtime failures" — CLOSED (test-harness artifact, NOT a bug):** the
  e2e-generator run showed gc-only 0/5 + hybrid 1/5 exit nonzero, but diagnosis (e2e-gc-diagnosis.md)
  found the fuzzbuild d8 ignores the `// Flags:` comment header. The templates correctly declare
  `--allow-natives-syntax --expose-gc`; the runner passes them explicitly (`FUZZING_FLAGS` +
  d8_wrapper/reprl default); with explicit flags gc-only is 5/5 clean and the campaign had 0 worker
  errors. No reconFuzz fix needed — only bare `d8 file.js` (no flags) fails for native-using programs.
- **E2 wasm-only output near-static** — only 84% distinct (21/25) vs 100% for other modes. Ties to
  C1/C2 (linear i32-only bodies, 2 templates). Confirm after the Wasm coverage fixes.

## B. Effectiveness / feedback-loop
- **B1 Scheduler ignores persisted energy/depth** — `src/runner/scheduler.py:37,50,58` · HIGH ·
  recomputes energy from scratch; never reads `Seed.energy`; `depth_bonus` unreachable; gain-only seeds
  miss `coverage_hash` bonus (bitmap not persisted). Fix: read persisted energy; persist bitmap or its
  digest; expose depth.
- **B2 Scheduler loop not closed end-to-end** — `scripts/fuzz.py:143-154,296-314,501-509` · HIGH · no
  per-seed execution/admission/runtime signal fed back into `select()`; op mix static 75/12.5/12.5,
  yield-blind. Fix: feed findings/energy back; make op mix adaptive.
- **B3 Stackless over-merge / weak dedup** — `src/runner/detector.py:226,231`, `corpus_manager.py:128` ·
  MED · generic titles + empty-output collapse distinct reports. Fix: normalized output/title signature
  fallback; keep discriminating context.
- **B4 Gain admission fragile under jitter** — `corpus_manager.py:149,169,177` · MED · single unseen bit
  → immediate retain + permanent merge, no stability threshold. Fix: stability/repeat threshold.
- **B5 Mutator: one-per-call, first-match-only, no mutator-level no-op retry** — `src/mutator/index.ts:50-62,82-90` ·
  MED · add a mutation budget/composition + continue past ineffective matches.
- **B6 Minimizer disconnected + coarse** — `src/mutator/minimizer.ts:19-62` · MED · library-only/never
  called; greedy single-statement; top-level only; no wasm. Fix: wire into the pipeline; chunk + expression
  minimization.
- **B7 fuzz_gc verbatim replay / no mutation** — `scripts/fuzz_gc.py:198-205` · MED · 50% hard-coded
  verbatim replay, no mutate/crossover. Fix: wire mutate/crossover like fuzz.py.
- **B8 daemon wedged-but-alive not detected** — `scripts/fuzz.py:186-223,447-455` · MED · restart only on
  exit. Fix: health-check + restart on stalled responses.
- **B9 `--seed` not reproducible** — `fuzz.py:125-130,327-330` · LOW · parent replay unseeded PRNG +
  PID-mixed worker ops. Fix: seed parent PRNG; drop PID from op choice.
- **B10 fuzz_gc no finite timeouts / generator timeout** — `fuzz_gc.py:63-67,94-95` · MED · validate
  positive finite; add generator + campaign deadlines.

## C. Coverage / ES support (the "full coverage" goal)
- **C1 Wasm structured control flow** — `wasm-builder.ts:92` · HIGH · bodies are linear i32-only; no
  block/loop/br/br_table/select/unreachable. Add structured control flow + richer bodies.
- **C2 Wasm value types beyond i32** — `wasm-builder.ts:12,17,18`; `js-wasm-glue.ts` · HIGH · enums have
  i64/f32/f64/v128/funcref/externref but all templates emit i32. Use i64/f32/f64; BigInt interop; fp edges.
- **C3 Wasm feature areas missing** — reference types/table/elements, bulk memory (copy/fill/init/drop,
  data-count), SIMD beyond v128 const, exception handling, tail calls, GC proposal, shared/atomic, memory64.
- **C4 GC coverage gaps** — `gc-templates.ts` · HIGH · no `WeakRef`/deref; no async-GC phase; bare `gc()`
  only (no scavenger vs mark-sweep / incremental / concurrent differentiation); no `ArrayBuffer.transfer`/
  postMessage; FinalizationRegistry no resurrection.
- **C5 Tier-up oracle** — `tierup.ts:166,184,197,203,248` · HIGH · empty catch, discarded returns, no
  `%GetOptimizationStatus` → deopts leave no evidence; only synthesized functions targeted. Add an oracle,
  keep signal, target grammar functions, add Maglev/TurboFan + deopt + polymorphic shapes.
- **C6 Codegen ES gaps** — `js-grammar.ts` · HIGH · missing: richer classes (fields/methods/getters/setters/
  heritage/super/computed keys), optional chaining, tagged templates, `in`/`instanceof`, Map/Set/WeakRef/
  Proxy/Reflect, numeric separators, rest params. (destructuring+spread, control-flow, edge tables already done.)
- **C7 Mutator wasm structural** — `src/mutator/wasm-mutators.ts` · MED · raw-byte only; add structural
  (section/function/instruction/index-aware) wasm mutation.
- **C8 Lifter enrichment** — `scripts/import_corpus.py` + `server.ts /lift` · LOW · extract feature metadata
  at import for better scheduling (done: validate+quarantine+normalize).

## Done this campaign (codex-authored, green: 122 TS / 115 pytest)
codegen: production weights/counters · type-hint soundness (class branch, operator split) · edge/compound
tables · control-flow (for-of/in/do-while/throw) · destructuring+spread · sign-merge correctness fix.
mutator: catalogue 7→14 multi-site. lifter: /lift endpoint + import_corpus validate/quarantine/normalize.
