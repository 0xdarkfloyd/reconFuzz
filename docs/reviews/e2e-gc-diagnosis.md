# E2E GC-only runtime diagnosis (host-side) — CORRECTED

## Method
Built each of the 5 GC templates via `printProgram(template.build(seed))` (each `build()`
returns a full `ReconfuzzProgram`), seeds 0–4, and ran each under the fuzzbuild d8 with a
5 s timeout. Also re-ran full `gc-only` generator output with explicit flags.

## Per-template results (with explicit `--allow-natives-syntax --expose-gc`)
| Template | seeds | exit codes |
| --- | --- | --- |
| arraybuffer-detach-gc | 5 | 0×5 (clean) |
| finalization-registry-gc | 5 | 0×5 (clean) |
| sharedarraybuffer-gc | 5 | 0×5 (clean) |
| wasm-instance-gc | 5 | 0×5 (clean) |
| weak-collection-gc | 5 | 0×5 (clean) |

Full `gc-only` generator output, seeds 0–4, with explicit flags: **5/5 rc=0 clean.**

## Root cause of the earlier "gc-only 0/5" finding — NOT a reconFuzz bug
The Fuzzilli-instrumented **fuzzbuild d8 does NOT honor the `// Flags:` comment header**. The
GC templates correctly declare `flags: ['--allow-natives-syntax', '--expose-gc']` (verified,
e.g. `gc-templates.ts:242`), and `printProgram` emits `// Flags: --allow-natives-syntax
--expose-gc`. But this d8 build ignores that header, so a bare `d8 file.js` (as the
e2e-generator harness ran) gets neither flag → `%ArrayBufferDetach`/`%`-natives → SyntaxError.
Test: `d8 --allow-natives-syntax --expose-gc file` → rc=0; `d8 file` (rely on header) → rc=1.

The **real runner always passes the flags explicitly**: `scripts/fuzz.py` `FUZZING_FLAGS`
includes `--expose-gc` + `--allow-natives-syntax`, and `d8_wrapper`/`reprl` default to
`["--allow-natives-syntax"]`. The bounded campaign confirmed **0 worker errors**. So the GC
path is healthy in the actual fuzzer.

## Conclusion
E1 ("gc-only runtime failures") is a **test-harness artifact** (running d8 without the flags
it needs), not a reconFuzz defect. No source fix required. (The earlier wrong hypothesis —
"arraybuffer-detach missing --allow-natives-syntax" — is retracted; the flag is present.)

## Side-note
`sharedarraybuffer-gc` runs clean — confirms the SAB wait/notify fix (A7) holds at runtime.
