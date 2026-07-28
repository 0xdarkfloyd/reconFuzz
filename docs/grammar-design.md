# Grammar Design

reconfuzz uses a typed, probabilistic AST grammar. The design is inspired by the
minimal but dense trigger patterns found in `big_sleep` and `jshitter`, plus the
cross-cutting need to stress V8's garbage collector.

## Type hints

Every expression is generated with a `TypeHint` that guides production:

```typescript
export type TypeHint =
  | 'any'
  | 'number'
  | 'string'
  | 'boolean'
  | 'object'
  | 'array'
  | 'function'
  | 'typedarray'
  | 'promise'
  | 'symbol'
  | 'weakmap'
  | 'weakset'
  | 'finalizationregistry';
```

The GC-related hints (`weakmap`, `weakset`, `finalizationregistry`) ensure the
grammar can build the weak-reference patterns observed in both corpora.

## JS AST node inventory

### Statements

- `VariableDeclaration` with exotic destructuring (holes, nested arrays, objects).
- `ForStatement` with small literal bounds and unusual update expressions.
- `WhileStatement`, `DoWhileStatement`.
- `IfStatement` / `ConditionalExpression`.
- `TryStatement` / `CatchClause` / `ThrowStatement`.
- `ExpressionStatement`.
- `BlockStatement`.
- `WithStatement`.
- `DebuggerStatement`.
- `gc()` expression statement for GC timing.

### Expressions

- Literals: numbers (edge values), strings, booleans, null, regex.
- `Identifier` (generated variable names like `__v_0`).
- `ArrayExpression` with holes.
- `ObjectExpression` with getters, setters, computed keys, `__proto__`.
- `MemberExpression` / `OptionalMemberExpression`.
- `CallExpression` / `NewExpression` / `OptionalCallExpression`.
- `AssignmentExpression` (including destructuring assignment).
- `UpdateExpression` / `UnaryExpression` / `BinaryExpression`.
- `SpreadElement`.
- `AwaitExpression` / `YieldExpression`.
- `TemplateLiteral`.
- `TaggedTemplateExpression`.
- `WeakMap`, `WeakSet`, `FinalizationRegistry` constructors.

### Functions

- `FunctionDeclaration` / `FunctionExpression` / `ArrowFunctionExpression`.
- `AsyncFunctionDeclaration` / `AsyncFunctionExpression`.
- `GeneratorFunctionDeclaration` / `GeneratorFunctionExpression`.
- `AsyncGeneratorFunctionDeclaration`.
- `ClassDeclaration` / `ClassExpression` with `extends`, `super`, private fields, static blocks.

### Built-in stressors

- Typed arrays: `Int8Array`, `Uint8Array`, `Int32Array`, `Float32Array`, `BigInt64Array`.
- `ArrayBuffer`, `SharedArrayBuffer`, `DataView`, resizable buffers.
- `Map`, `Set`, `WeakMap`, `WeakSet`, `FinalizationRegistry`.
- `Proxy`, `Reflect`.
- `RegExp` with backreferences and lookbehind.
- `Intl.Collator`, `Intl.DateTimeFormat`, `Intl.Segmenter`.
- `eval`, `Function`, `Promise`, `Symbol`.
- `gc()` (requires `--expose-gc`).

## Wasm IR inventory

The `WasmModuleBuilder` supports:

- All standard sections.
- Custom sections used by V8:
  - `metadata.code.instr_freq`
  - `metadata.code.call_targets`
  - `metadata.code.compilation_hints`
- Experimental features (flag-gated):
  - wasmfx
  - exception handling
  - stringref
  - custom descriptors
  - shared memory
  - growable stacks
  - memory control

## GC inventory

The grammar and templates can generate:

- `WeakMap` / `WeakSet` construction and churn.
- `FinalizationRegistry` registration/unregistration.
- `ArrayBuffer` detach via `%ArrayBufferDetach`.
- `SharedArrayBuffer` + `Atomics` operations.
- `gc()` calls at random statement positions and inside callbacks.
- Wasm instantiation loops with periodic GC.

## Generation strategy

1. Pick a target subsystem based on scheduler weights.
2. Select a template or grammar entry point (e.g., "async generator recursion",
   "Wasm wrapper optimization", "typed array coercion", "WeakMap churn").
3. Fill template slots using the type-directed expression generator.
4. Inject edge values and coercion traps with configurable probability.
5. Optionally inject `gc()` calls or d8 GC natives.
6. Emit the final program and required flags.

## Mutation strategy

- Preserve AST validity.
- Prefer small, local changes.
- Combine unrelated features with low probability.
- Inject or remove `gc()` calls to vary timing.
- After a crash, use the minimizer to remove statements that are not required
  for the signature.

## Edge values

The grammar uses a curated set of numeric edge values:

```typescript
const EDGE_NUMBERS = [
  0, -0, 1, -1, NaN, Infinity, -Infinity,
  0x7fffffff, 0x80000000, -0x80000000,
  0x100000000, 2 ** 53, -(2 ** 53),
];
```

These values are chosen to hit common representation boundaries in V8: Smi
vs. HeapNumber, signed 32-bit overflow, double exponent edges, and NaN
handling.
