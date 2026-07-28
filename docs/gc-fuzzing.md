# GC Fuzzing Strategy

V8's garbage collector (Oilpan + Scavenger/Mark-Compact) is a rich source of
security bugs.  This document explains how reconfuzz targets it and how the
historical POCs informed the design.

## Why GC bugs matter

GC bugs in V8 often manifest as:

- **Use-after-free** — an object is collected while a native pointer still
  references it.
- **Out-of-bounds access** — object layout changes after a moving collection.
- **Type confusion** — wrong map/shape is observed because a write barrier was
  missed.
- **CHECK/DCHECK failures** — invariants about heap object states are violated.

These bugs are high impact because they can provide reliable exploit primitives
from apparently benign JavaScript.

## Evidence from the POC corpora

### big_sleep

- Issue **490058871**: `SharedArrayBuffer` + `Atomics.waitAsync` followed by
  `gc()` causes a race/collection issue.
- Issue **493634179**: `%WasmTriggerCodeGC()` + `%FlushLiftoffCode()` while
  compiling and instantiating Wasm modules stresses code GC.
- Issue **494583765**: `// Flags: --shared-heap --heap-snapshot-on-gc=0` with a
  bare `gc()` call.
- Issue **498818402**: `WebAssembly.MemoryMapDescriptor` survives a GC in an
  unexpected way.

### lokihardt_jshitter

- Multiple issues use `WeakMap` construction with large or malformed arguments.
- `gc()` is sometimes called after recursive generator/async patterns that
  create many short-lived objects.

## GC trigger primitives

reconfuzz provides these primitives to force collection at sensitive moments:

| Primitive | Purpose |
|---|---|
| `gc()` | Full synchronous collection (requires `--expose-gc`) |
| `%ArrayBufferDetach(ab)` | Detach an ArrayBuffer and invalidate its backing store |
| `%WasmTriggerCodeGC()` | Force GC of compiled Wasm code |
| `%FlushLiftoffCode()` | Flush Liftoff code to trigger recompilation + GC |
| `WeakMap` / `WeakSet` | Create weak edges that may disappear during collection |
| `FinalizationRegistry` | Register cleanup callbacks that run during collection |

## GC templates

`src/generator/gc-templates.ts` implements templates derived from the POCs:

### `WasmInstanceGcTemplate`

Repeatedly instantiates `WebAssembly.Instance` and calls `gc()` every 10
iterations.  Targets code GC and instance object transitions.

### `ArrayBufferDetachGcTemplate`

Creates a `DataView` over an `ArrayBuffer`, detaches the buffer with the d8
native, then accesses the view and calls `gc()`.  Targets detached-buffer
invariants and external pointer handling.

### `WeakCollectionGcTemplate`

Builds a deep object graph, stores it in `WeakMap`/`WeakSet`, drops the strong
reference, and calls `gc()`.  Targets weak-edge processing and write barriers.

### `FinalizationRegistryGcTemplate`

Registers objects with `FinalizationRegistry`, unregisters some with tokens,
drops strong references, and calls `gc()`.  Targets callback scheduling and
resurrection handling.

### `SharedArrayBufferGcTemplate`

Recreates the big_sleep `Atomics.waitAsync` / `Atomics.notify` + `gc()`
pattern.  Targets shared-memory GC invariants.

## Running GC campaigns

Use the dedicated loop:

```bash
python scripts/fuzz_gc.py \
  --d8 /path/to/d8 \
  --iterations 1000 \
  --corpus seeds/gc-corpus \
  --crashes seeds/gc-crashes \
  --timeout 20
```

Or use the general loop in `gc-only` mode:

```bash
npm run generate:gc -- --output tmp/gc.js
python scripts/reproduce.py --d8 /path/to/d8 --testcase tmp/gc.js
```

## Suggested GC flag combinations

```bash
--expose-gc
--trace-gc-verbose
--heap-snapshot-on-gc=0
--shared-heap
--gc-memory-reducer-start-delay-ms=0
--memory-reducer
```

## Extending GC fuzzing

Future improvements derived from the corpus:

1. **Cross-worker GC**: Create `Worker` threads that share Wasm modules or SABs
   and trigger `gc()` from the main thread.
2. **Moving collection stress**: Allocate many small objects to force nursery
   evacuation, then access raw addresses via `Sandbox.getAddressOf` if
   available.
3. **WeakRef resurrection**: Use `WeakRef` + `FinalizationRegistry` to observe
   object lifetime edges.
4. **ArrayBuffer resizable/shared variants**: Combine `transfer`, `detach`, and
   resizable buffers with GC.
5. **Wasm GC types**: Generate WasmGC `struct`/`array` types and call `gc()`
   while refs cross the JS/Wasm boundary.
