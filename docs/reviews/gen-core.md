# Generator core review

Scope: `src/generator/printer.ts` and `src/generator/index.ts` only.

## 1. Structure map

### `printProgram`

- The function performs only a top-level non-null object check, applies defaults that enable both the flags header and helper includes, and accumulates output as separately generated lines (`src/generator/printer.ts:14-25`).
- Flags are filtered to non-empty, whitespace-free tokens; surviving values are joined into one `// Flags:` comment before all executable text (`src/generator/printer.ts:27-36`).
- Includes are emitted next, in input order, as `d8.file.execute(...)` statements with each include string serialized by `JSON.stringify` (`src/generator/printer.ts:38-42`).
- The JavaScript AST is deep-cloned, Wasm modules are indexed by name with last-duplicate-wins behavior, and a traversal rewrites exact calls of the form `__reconfuzz_wasm_bytes("name")` (`src/generator/printer.ts:44-64`).
- A resolved placeholder becomes an array literal containing the module bytes in order; an unresolved name becomes an empty array literal (`src/generator/printer.ts:64-71`).
- Babel generator emits the cloned and rewritten AST with `compact: false` and `comments: true`; that text is appended after headers and includes and joined with newlines (`src/generator/printer.ts:75-81`).

### `Generator` and CLI

- Construction validates one of four modes, defaults an omitted seed to zero for initialization, creates `JsGrammar`, and creates a separate seed-derived template RNG; `setSeed` resets both RNG paths (`src/generator/index.ts:41-63`).
- `generate()` resets the shared ID counter and dispatches all four declared modes: `js-only`, `wasm-only`, `hybrid`, and `gc-only` (`src/generator/index.ts:97-112`).
- `js-only` returns grammar output with its required flags and no Wasm modules or includes; `wasm-only` and `gc-only` select and build from their respective template arrays and report an empty-template condition (`src/generator/index.ts:114-138`).
- `hybrid` starts from a Wasm template, appends a GC template 35% of the time, then appends grammar-generated JavaScript; it merges same-name Wasm modules after byte equality checks and deduplicates flags/includes while preserving first occurrence order (`src/generator/index.ts:75-95`, `src/generator/index.ts:140-175`).
- CLI parsing defaults to `hybrid` and seed zero, accepts separate-value forms of `--output`, `--mode`, and `--seed`, validates the mode and a signed safe-integer seed, and rejects every other argument (`src/generator/index.ts:181-225`).
- `main()` generates and prints once; without `--output` it writes source to stdout, while an output path causes recursive parent creation and a synchronous UTF-8 write with wrapped write errors (`src/generator/index.ts:228-247`).
- The CommonJS entry guard reports errors, adds usage text only for CLI argument errors, and sets a nonzero exit status (`src/generator/index.ts:250-259`).

## 2. Correctness & robustness

- **CONFIRMED, high:** A generated hashbang can be displaced by the default flags comment or include statements. Babel's generated text is always appended after those prefixes, but JavaScript requires a hashbang to occupy the start of the source, so a `Program.interpreter` plus either prefix can produce invalid output (`src/generator/printer.ts:34-42`, `src/generator/printer.ts:75-81`).
- **CONFIRMED, high:** Helper includes precede the generated program. Consequently, an original directive such as `"use strict"` is no longer in the whole script's directive prologue whenever at least one include is emitted, changing program semantics even though Babel prints the directive (`src/generator/printer.ts:38-42`, `src/generator/printer.ts:75-81`).
- **CONFIRMED, high:** Hybrid construction copies only the three input `Program.body` arrays into a new `Program`. Program-level directives, interpreter/hashbang, source type, and other program metadata are not passed to the new node, so hybrid generation can drop them before printing (`src/generator/index.ts:154-160`).
- **CONFIRMED, medium:** The flag check is sanitation, not whitelisting: any non-empty token without whitespace is accepted, with no allowed-name/value schema, required `--` prefix, or deduplication in the printer. Unsupported but whitespace-free flag text therefore reaches the header unchanged (`src/generator/printer.ts:27-35`).
- **CONFIRMED, medium:** Placeholder resolution is byte-for-byte and order-preserving for a unique matching module because every `Uint8Array` element becomes a numeric literal in `Array.from` order (`src/generator/printer.ts:64-71`). Missing names, however, silently become `[]`, which converts a broken reference into a different valid program instead of surfacing the mismatch (`src/generator/printer.ts:64-67`).
- **CONFIRMED, medium:** Duplicate module names supplied directly to the printer only produce a warning and the last byte array wins. This differs from hybrid merging, which rejects same-name modules when their bytes differ (`src/generator/printer.ts:45-51`, `src/generator/index.ts:75-94`).
- **CONFIRMED, medium:** The placeholder match is deliberately narrow: only a bare identifier call with exactly one `StringLiteral` argument is rewritten. Optional calls, member calls, computed names, dynamic arguments, and extra arguments remain in emitted source (`src/generator/printer.ts:53-63`).
- **CONFIRMED, medium:** Any ordinary source call that happens to use the reserved identifier and matching shape is also rewritten; the traversal does not establish whether the identifier is bound to the intended placeholder (`src/generator/printer.ts:53-70`).
- **CONFIRMED, medium:** Include paths receive sound literal quoting for quotes, backslashes, line breaks, and control characters through `JSON.stringify`; AST strings, regular expressions, and template literals are instead escaped and printed by Babel generator rather than local string concatenation (`src/generator/printer.ts:38-40`, `src/generator/printer.ts:75-78`).
- **LIKELY, medium:** Untouched AST comments are requested through `comments: true`, but replacement does not explicitly transfer comments attached to a placeholder `CallExpression`; comments whose ownership is the replaced node may be lost or repositioned by traversal/generator behavior (`src/generator/printer.ts:53-73`, `src/generator/printer.ts:75-78`).
- **CONFIRMED, medium:** Runtime validation stops after checking that `program` is a non-null object. Missing or malformed `flags`, `includes`, `wasm`, or `javascript` fields fail later with incidental errors, and malformed Babel nodes are passed directly to traversal/generation (`src/generator/printer.ts:18-22`, `src/generator/printer.ts:27-28`, `src/generator/printer.ts:38-46`, `src/generator/printer.ts:53-78`).
- **CONFIRMED, low:** CLI and constructor accept every safe integer seed, but the template RNG input uses bitwise XOR, which coerces the seed to 32 bits. Distinct safe-integer seeds separated by a multiple of 2^32 can therefore share the same template-choice stream even though template builders still receive the original numeric seed (`src/generator/index.ts:35-38`, `src/generator/index.ts:50-55`, `src/generator/index.ts:129-137`, `src/generator/index.ts:212-218`).
- **SPECULATIVE, low:** `resetIdCounter()` is global state reset on every `generate()` call; concurrent or re-entrant generator use could interfere with ID allocation if generation yields or callbacks re-enter generation (`src/generator/index.ts:97-99`).
- **CONFIRMED, low:** File output writes directly to the destination rather than a temporary file plus rename, so replacement of an existing output is not atomic (`src/generator/index.ts:235-243`).

## 3. Coverage/feature gaps

- The printer is a Babel AST emitter, not a lexical round-tripper. It configures only compactness and comment emission, so exact quote style, numeric spelling, whitespace, parentheses, and other original token choices are not a stated preservation target (`src/generator/printer.ts:75-81`).
- There is no local exclusion for computed member keys, object/class getters and setters, class fields, `BigIntLiteral`, `RegExpLiteral` flags, or import/export nodes: valid nodes are delegated to the installed Babel generator. Conversely, this layer neither validates those node forms nor supplies a fallback if the installed generator cannot emit one (`src/generator/printer.ts:44-44`, `src/generator/printer.ts:75-78`).
- Regex patterns/flags and template literal raw/cooked fields receive no printer-specific validation or normalization. Their fidelity therefore depends on the validity and completeness of the incoming Babel AST (`src/generator/printer.ts:18-22`, `src/generator/printer.ts:75-78`).
- Module syntax can be emitted by the generic Babel path, but hybrid reconstruction does not propagate the constituent programs' `sourceType`; the newly constructed program therefore loses module/script metadata supplied by those inputs (`src/generator/index.ts:154-160`, `src/generator/printer.ts:75-78`).
- Wasm re-expansion covers only exact string-named sentinel calls and has no validation pass ensuring that every module is referenced exactly once or that every sentinel resolves (`src/generator/printer.ts:45-70`).
- All four advertised modes have concrete dispatch and generation paths; none is a stub in these files. The hybrid path is the only cross-domain composition path, and GC participation there is probabilistic rather than guaranteed (`src/generator/index.ts:19-24`, `src/generator/index.ts:97-138`, `src/generator/index.ts:140-175`).
- The CLI exposes no JavaScript grammar configuration even though `GeneratorConfig` supports it; CLI construction passes only mode and seed (`src/generator/index.ts:13-17`, `src/generator/index.ts:228-233`).
- CLI syntax covers only space-separated long options. `--name=value`, a successful `--help`, a `--` terminator, positional input, and stdin conventions are not implemented by the equality-based dispatch, and this CLI has no parse/transform path for existing source (`src/generator/index.ts:198-223`, `src/generator/index.ts:228-247`).
- `parseCliArgs` and `main` are file-private, limiting direct unit coverage of argument and output behavior without invoking the module entry point (`src/generator/index.ts:189-193`, `src/generator/index.ts:228-250`).

## 4. Prioritized improvement list

1. Preserve the hashbang at byte zero and insert helper statements after any directive prologue; this removes the two highest-impact syntax/semantic fidelity failures (`src/generator/printer.ts:34-42`, `src/generator/printer.ts:75-81`).
2. Build hybrid output by cloning a base `Program` and deliberately merging bodies, directives, interpreter, source type, and program comments; current body-only reconstruction discards program-level meaning (`src/generator/index.ts:154-160`).
3. Make unresolved and conflicting Wasm names structured generation errors, and validate sentinel/module cardinality; silent `[]` substitution and last-wins duplicates hide incomplete programs (`src/generator/printer.ts:45-70`).
4. Replace the whitespace-only flag filter with an explicit supported-flag schema plus deduplication and precise diagnostics; the current header admits any single token (`src/generator/printer.ts:27-35`).
5. Add runtime shape and Babel-node validation at the `printProgram` boundary, including actionable paths for malformed literals and program metadata; the current guard validates only object-ness (`src/generator/printer.ts:18-22`, `src/generator/printer.ts:44-78`).
6. Add printer conformance cases for computed properties, accessors, class fields, BigInt, regex flags, templates, module declarations, comments, directives, hashbangs, and sentinel calls; all currently share one generic generation path with one targeted rewrite (`src/generator/printer.ts:53-78`).
7. Define the seed domain as 32-bit or derive every RNG seed through an explicit full-width hash; the current API accepts safe integers while template choice truncates them through XOR (`src/generator/index.ts:35-38`, `src/generator/index.ts:50-62`, `src/generator/index.ts:212-218`).
8. Export/test CLI parsing, add standard long-option forms and help behavior, and use atomic destination replacement; these changes broaden usable generation coverage and make output behavior independently testable (`src/generator/index.ts:189-247`).
