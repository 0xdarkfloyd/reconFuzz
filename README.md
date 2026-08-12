# reconfuzz

**reconfuzz** is a research-oriented, structure-aware fuzzer that reconstructs
JavaScript and WebAssembly bug-finding strategies from historical Chromium/V8
proof-of-concept corpora, in particular the Google `big_sleep` collection and
the Lokihardt `jshitter` collection.  It is designed to discover new
vulnerabilities, support variant analysis, and be extensible enough to target
parser, compiler, runtime, sandbox, WebAssembly, and garbage-collector bugs.

## What reconfuzz does

1. **Generates valid-but-weird JavaScript** ASTs that stress the V8 parser,
   bytecode generator, interpreter, Maglev, TurboFan/Turboshaft, and runtime
   invariants.
2. **Generates handcrafted WebAssembly modules** with standard and custom
   sections, experimental features, and JS↔Wasm wrapper stressors.
3. **Targets V8's garbage collector** with dedicated templates for weak
   collections, finalization registries, ArrayBuffer detach/transfer, and GC
   during Wasm instantiation.
4. **Detects crashes, sanitizer reports, and V8-specific failure signatures**
   when running generated testcases under `d8`.
5. **Schedules and deduplicates** interesting seeds using AFL-style energy,
   coverage novelty, and crash-signature deduplication.

## Repository layout

```
reconfuzz/
├── docs/                   # Architecture, tutorial, corpus study, GC guide
├── src/
│   ├── generator/          # TypeScript: AST grammar, Wasm builder, GC templates
│   ├── mutator/            # TypeScript: structure-aware mutators + minimizer
│   └── runner/             # Python: d8 runner, detector, scheduler, corpus
├── harness/                # d8 helper scripts and stubs
├── seeds/                  # Historical POC corpora (not committed by default)
├── tests/                  # Unit tests for generator, mutator, runner
├── scripts/                # fuzz, fuzz_gc, import_corpus, reproduce, setup_v8
└── .github/workflows/      # CI
```

## Tech stack

- **Generator / Mutator**: TypeScript (Node.js)
  - Fast AST IPC Daemon via localized REST API to bypass Node startup latency.
  - Guaranteed JIT Tier-Up mapping via deterministic `try/catch` wrapping and Type tracking.
  - Uses `@babel/parser`, `@babel/types`, `@babel/generator`, `@babel/traverse`
    for JS AST manipulation.
  - Self-contained Wasm IR builder and encoder (no external `wasm-encoder`
    dependency).
  - Dedicated GC-fuzzing templates derived from real POCs.
- **Runner / Orchestrator**: Python 3.10+
  - Parallel orchestration across multiple CPU cores via `ProcessPoolExecutor`.
  - Coverage feedback from Fuzzilli-instrumented d8 builds (`v8_fuzzilli=true`):
    the runner hands each `d8` process a shared-memory edge bitmap via
    `SHM_ID` and reads native edge coverage back directly. d8 LCOV/block-count
    output is used as a fallback; builds without a supported coverage channel
    report coverage as unavailable rather than treating source identity as
    execution feedback.
  - Corpus admission is coverage-gain based by default (`--admission gain`):
    a testcase is retained for replay/mutation only when its edge bitmap
    covers at least one globally new edge. `--admission hash` falls back to
    exact-coverage-hash novelty.
  - Manages `d8` processes, parses sanitizer/crash output, schedules corpus,
    and deduplicates findings.

## Quick start

### 1. Install TypeScript dependencies

```bash
npm install
npm run build
```

### 2. Install Python dependencies

```bash
python -m venv .venv
# Linux/macOS:
source .venv/bin/activate
# Windows:
.venv\Scripts\activate

pip install -e ".[dev]"
```

### 3. Generate a sample testcase

```bash
npm run generate -- --output tmp/sample.js
```

### 4. Run the continuous fuzzing loop (dry-run without d8)

```bash
python scripts/fuzz.py --iterations 100 --mode hybrid --corpus tmp/corpus --crashes tmp/crashes
```

### 5. Build or obtain d8 and fuzz for real

See [docs/v8-setup.md](docs/v8-setup.md) for building V8 from source, then:

```bash
python scripts/fuzz.py \
  --d8 /path/to/d8 \
  --iterations 1000 \
  --mode hybrid \
  --corpus seeds/corpus \
  --crashes seeds/crashes
```

## Documentation

- [Architecture](docs/architecture.md) — component design and data flow.
- [Tutorial](docs/tutorial.md) — step-by-step guide to fuzzing V8.
- [V8 Setup](docs/v8-setup.md) — building V8 from source.
- [Corpus Study](docs/corpus-study.md) — what we learned from `big_sleep` and `jshitter`.
- [Grammar Design](docs/grammar-design.md) — AST grammar and generation strategy.
- [GC Fuzzing](docs/gc-fuzzing.md) — garbage-collector testing strategy.
- [Variant Analysis](docs/variant-analysis.md) — turning one crash into many.
- [Command Reference](docs/commands.md) — all CLI commands and scripts.

## Key features

| Feature | Status | Files |
|---|---|---|
| JS AST grammar | implemented | `src/generator/js-grammar.ts` |
| Wasm IR builder | implemented | `src/generator/wasm-builder.ts` |
| JS↔Wasm glue templates | implemented | `src/generator/js-wasm-glue.ts` |
| GC stress templates | implemented | `src/generator/gc-templates.ts` |
| Structure-aware mutator | implemented | `src/mutator/` |
| d8 runner + detector | implemented | `src/runner/` |
| Corpus scheduler | implemented | `src/runner/scheduler.py` |
| Continuous fuzzing loop | implemented | `scripts/fuzz.py` |
| GC-focused loop | implemented | `scripts/fuzz_gc.py` |
| V8 build helper | implemented | `scripts/setup_v8.py` |
| POC corpus importer | implemented | `scripts/import_corpus.py` |

## Development

```bash
# TypeScript watch build
npm run watch

# Run all tests
npm test
pytest

# Lint / type-check
npm run lint
ruff check src/runner scripts tests
black --check src/runner scripts tests
mypy src/runner scripts
```

## Contributing workflow

1. Import historical POCs with `scripts/import_corpus.py`.
2. Study crash families in `docs/corpus-study.md`.
3. Add grammar rules or templates that reproduce the trigger pattern.
4. Add detector signatures if a new failure mode appears.
5. Run `pytest` and `npm test` before committing.

## License

MIT
