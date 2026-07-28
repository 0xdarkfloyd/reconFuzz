# Variant Analysis Plan

Variant analysis is the process of taking one confirmed bug and systematically
deriving related bugs.  reconfuzz is built to make this workflow repeatable.

## The core idea

A single POC encodes a *trigger pattern*: a combination of language features,
engine flags, and runtime state that violates an invariant.  The same pattern
often applies to:

- Different AST shapes (syntactic variants).
- Different JIT tiers (optimization-level variants).
- Different subsystems (Wasm vs. JS vs. GC variants).
- Different memory layouts (32-bit vs. 64-bit, sandboxed vs. unsandboxed).

## Variant generation strategies

### 1. Subsystem substitution

Take a JS-only crash and add a Wasm module, or vice versa:

```bash
# Original crash is JS-only
python scripts/reproduce.py --d8 /path/to/d8 --testcase crash.js

# Variant: wrap the same logic in a Wasm host
python scripts/fuzz.py --d8 /path/to/d8 --mode hybrid --iterations 100
```

### 2. JIT tier toggling

Run the same testcase under different compiler configurations:

```bash
/path/to/d8 --no-liftoff crash.js
/path/to/d8 --no-maglev crash.js
/path/to/d8 --no-turbofan crash.js
/path/to/d8 --maglev crash.js
/path/to/d8 --turboshaft-wasm crash.js
```

Many compiler bugs only appear in one tier.  A crash in Liftoff may have a
separate variant in TurboFan.

### 3. Feature flag permutation

The POC corpora show that experimental flags often expose latent bugs:

```bash
--experimental-wasm-gc
--experimental-wasm-shared
--experimental-wasm-custom-descriptors
--experimental-wasm-stringref
--experimental-wasm-wasmfx
--experimental-wasm-js-interop
--js-decorators
--harmony-shadow-realm
```

Create a matrix of flags and re-run the minimized crash under each.

### 4. AST minimization then generalization

1. Minimize the crash with `src/mutator/minimizer.ts`.
2. Identify the minimal set of statements required.
3. Replace literals with edge values, swap operators, or change variable kinds.
4. Re-run each variant.

### 5. Cross-corpus pattern blending

Combine patterns from `big_sleep` and `jshitter`:

- Take the Wasm module builder style from `big_sleep`.
- Add the deep destructuring / generator recursion from `jshitter`.
- Insert GC trigger primitives.

### 6. Architecture and build variants

If you have access to multiple builds:

- Debug vs. release.
- With and without the V8 sandbox.
- 32-bit vs. 64-bit.
- Pointer compression enabled/disabled.

Some bugs are DCHECK-only in debug builds but exploitable in release.

## Workflow in reconfuzz

1. **Find a crash** with `scripts/fuzz.py`.
2. **Minimize** it with the AST minimizer (CLI to be added; API available in
   `src/mutator/minimizer.ts`).
3. **Extract the trigger pattern** from `meta.json` and the minimized source.
4. **Create a template** in `src/generator/` that reproduces the pattern.
5. **Run a targeted campaign** using that template and flag permutations.
6. **Deduplicate** results by `stack_hash` in `corpus_manager.py`.
7. **Report** unique crashes.

## Automation goals

Future work:

- `scripts/variant.py --seed CRASH_DIR` that automatically runs a crash through
  all tier and flag variants.
- Integration with `clusterfuzz` reproducer minimization.
- Automatic template extraction from a minimized crash.

## Example variant matrix

| Variant | Flags | Expected outcome |
|---|---|---|
| baseline | `--allow-natives-syntax` | original crash |
| no liftoff | `--no-liftoff` | may hide or expose bug |
| no turbofan | `--no-turbofan` | may hit interpreter/Maglev path |
| maglev only | `--maglev --no-turbofan` | mid-tier variant |
| wasm features | `--experimental-wasm-gc` | cross-subsystem variant |
| GC stress | `--expose-gc --trace-gc-verbose` | GC timing variant |
| sandbox off | `--no-v8-sandbox` | may change exploitability |
