# Corpus Study

This document summarizes the two historical POC corpora that drive reconfuzz
design decisions, with emphasis on patterns that can be reconstructed and
extended.

## big_sleep

- **Size**: ~160 issues, ~158 downloaded JavaScript testcases.
- **ID range**: 490,058,871 – 538,229,286.
- **Dominant subsystems**: WebAssembly, Liftoff, Turboshaft/Turbolev, Maglev,
  V8 sandbox, garbage collector.
- **Common patterns**:
  - Hand-built `WasmModuleBuilder` with custom sections
    (`metadata.code.instr_freq`, `metadata.code.call_targets`,
    `metadata.code.compilation_hints`).
  - Experimental Wasm features: wasmfx, stringref, custom descriptors, shared
    memory, growable stacks, exception handling, memory control.
  - JS↔Wasm wrapper stress: `turbolev-inline-js-wasm-wrappers`, optimization
    natives, `Sandbox.MemoryView` metadata corruption.
  - Tiering flags: `--liftoff-only`, `--no-liftoff`, `--turboshaft-wasm`,
    `--maglev`.
  - GC stress: `gc()` calls around `SharedArrayBuffer`, `WebAssembly.Instance`,
    and `ArrayBuffer` detach.

## lokihardt_jshitter

- **Size**: ~131 issues, ~127 downloaded JavaScript testcases.
- **ID range**: 40,050,233 – 499,319,121.
- **Dominant subsystems**: parser, bytecode generator, interpreter, Maglev,
  compiler frontend, heap/GC.
- **Common patterns**:
  - Compact generated JS with deterministic small loops.
  - Deep destructuring, holes, computed property names.
  - Async/generator functions and `yield*` recursion.
  - Exotic coercions via getters/setters, `Proxy`, `Reflect`.
  - `RegExp` and `asm.js` parser edge cases.
  - Heap pressure via large arrays, `WeakMap`, and GC timing.
  - Repetitive assignment and redeclaration of the same identifier.

## Cross-corpus insights

1. Most crashes are invariant failures (`CHECK`, `DCHECK`, `ASSERT`,
   `Fatal error`, `Unreachable code`) rather than clean memory-safety bugs.
2. Memory-safety outliers (null dereference, UAF, buffer overflow, sandbox
   violation) are the highest-value targets for a new fuzzer.
3. Many POCs require `d8` natives and experimental flags; the runner must
   support per-testcase flag headers.
4. Minimized testcases are tiny (often <20 lines), so the generator should aim
   for small, dense trigger patterns.
5. GC appears in both corpora, often as a timing primitive rather than the
   primary subject, suggesting GC timing is a powerful cross-cutting mutation.

## Reconstructing patterns into templates

| Corpus pattern | reconfuzz implementation |
|---|---|
| `WasmModuleBuilder` + custom sections | `src/generator/wasm-builder.ts` |
| JS↔Wasm wrapper optimization | `src/generator/js-wasm-glue.ts` |
| `SharedArrayBuffer` + `Atomics` + `gc()` | `src/generator/gc-templates.ts` |
| `WeakMap` / `WeakSet` churn | `src/generator/gc-templates.ts` |
| Deep destructuring / holes | `src/generator/js-grammar.ts` |
| Async/generator recursion | `src/generator/js-grammar.ts` |
| Edge-value literals | `EDGE_NUMBERS` in `src/generator/js-grammar.ts` |
| d8 natives (`%OptimizeFunctionOnNextCall`) | `harness/v8-helpers.js` + flags |

## Design implications

- The grammar must cover both pure-JS syntax/runtime stressors and Wasm/JIT
  stressors.
- The runner must detect V8-specific strings, not just sanitizer output.
- The scheduler should weight seeds by subsystem coverage to avoid overfitting
  to one crash family.
- GC timing should be available as a mutation that can be applied to any
  generated program, not only GC-specific templates.
