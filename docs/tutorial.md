# reconfuzz Tutorial: Fuzzing Chrome V8

This tutorial walks through installing reconfuzz, building V8, generating
testcases, and running a continuous fuzzing campaign against the V8 JavaScript
engine.

## Prerequisites

- Node.js 20+ and npm
- Python 3.10+
- Git
- For building V8:
  - **Linux**: GCC/Clang build tools, Python dev headers, ~16 GB disk, ~8 GB RAM
  - **macOS**: Xcode command line tools, ~16 GB disk
  - **Windows**: Visual Studio 2022 with C++ build tools and Windows 11 SDK,
    ~20 GB disk

## Step 1 — Install reconfuzz

```bash
git clone https://github.com/0xdarkfloyd/reconFuzz.git
cd reconFuzz

npm install
npm run build

python -m venv .venv
# Linux/macOS:
source .venv/bin/activate
# Windows:
.venv\Scripts\activate

pip install -e ".[dev]"
```

Verify the install:

```bash
npm test
pytest
```

## Step 2 — Generate your first testcase

reconfuzz has four generator modes:

| Mode | What it produces |
|---|---|
| `js-only` | Pure JavaScript stressors |
| `wasm-only` | WebAssembly modules with JS harness |
| `gc-only` | Garbage-collector stressors |
| `hybrid` | Mixed JS + Wasm + GC features |

Generate a hybrid sample:

```bash
npm run generate -- --mode hybrid --output tmp/sample.js --seed 42
cat tmp/sample.js
```

Generate a GC-focused sample:

```bash
npm run generate:gc -- --output tmp/gc-sample.js --seed 7
cat tmp/gc-sample.js
```

## Step 3 — Build V8 from source

The helper script downloads depot_tools, syncs V8, and compiles `d8`:

```bash
python scripts/setup_v8.py --workdir ../third_party --build-type release
```

This step downloads several gigabytes of source and can take 30–90 minutes.
On Windows, ensure Visual Studio 2022 is installed first.  See
[v8-setup.md](v8-setup.md) for platform-specific troubleshooting.

After a successful build, the binary path is printed, e.g.:

```
d8 binary: ../third_party/v8/out/release/d8
```

If you already have a `d8` binary (for example from a Chromium checkout), you
can skip this step and use its path directly.

## Step 4 — Reproduce a single testcase

Run one generated file under d8:

```bash
python scripts/reproduce.py \
  --d8 ../third_party/v8/out/release/d8 \
  --testcase tmp/sample.js
```

The script reads the `// Flags:` header, runs d8 with the requested flags, and
prints the detector classification.

## Step 5 — Import historical POCs as seeds

The `big_sleep` and `lokihardt_jshitter` corpora are not committed to git, but
you can point `import_corpus.py` at them:

```bash
python scripts/import_corpus.py ../big_sleep \
  --corpus seeds/corpus --crashes seeds/crashes

python scripts/import_corpus.py ../lokihardt_jshitter \
  --corpus seeds/corpus --crashes seeds/crashes
```

This creates on-disk seed entries that the scheduler can select during
mutation.

## Step 6 — Run a continuous fuzzing campaign

### Dry-run mode (no d8 required)

Useful for validating the generator and corpus scheduler:

```bash
python scripts/fuzz.py \
  --iterations 100 \
  --mode hybrid \
  --corpus tmp/corpus \
  --crashes tmp/crashes
```

### Live fuzzing with d8

```bash
python scripts/fuzz.py \
  --d8 ../third_party/v8/out/release/d8 \
  --iterations 1000 \
  --mode hybrid \
  --corpus seeds/corpus \
  --crashes seeds/crashes \
  --timeout 15
```

### GC-focused campaign

```bash
python scripts/fuzz_gc.py \
  --d8 ../third_party/v8/out/release/d8 \
  --iterations 500 \
  --corpus seeds/gc-corpus \
  --crashes seeds/gc-crashes \
  --timeout 20
```

## Step 7 — Inspect findings

Crashes are saved under the `--crashes` directory with this structure:

```
seeds/crashes/
└── <seed-id>/
    ├── testcase.js
    └── meta.json
```

`meta.json` contains the crash class, title, stack hash, and flags.  Re-run a
crash manually:

```bash
cd seeds/crashes/<seed-id>
/path/to/d8 $(cat meta.json | python -c "import sys,json; print(' '.join(json.load(sys.stdin)['flags']))") testcase.js
```

## Step 8 — Minimize and do variant analysis

After finding a crash, reduce it with the AST minimizer:

```bash
# TODO: expose minimizer CLI (see docs/variant-analysis.md)
```

Then use the strategies in [variant-analysis.md](variant-analysis.md) to
explore related code paths:

- Swap the subsystem (e.g., replace Wasm with JS-only).
- Toggle JIT tiers (`--no-liftoff`, `--maglev`, `--no-turbofan`).
- Add or remove GC pressure points.
- Combine the crash pattern with other templates.

## Step 9 — Add your own grammar rule

1. Open `src/generator/js-grammar.ts`.
2. Add a new `generateXxxStatement` or `generateXxxExpression` method.
3. Add it to the weighted `choices` array in `generateStatement` or
   `generateAnyExpression`.
4. Rebuild and test:

```bash
npm run build
npm test
node dist/generator/index.js --mode js-only --output tmp/custom.js
```

## Common flags for V8 fuzzing

| Flag | Purpose |
|---|---|
| `--allow-natives-syntax` | Enable `%` debugging natives |
| `--expose-gc` | Enable `gc()` function in JS |
| `--no-liftoff` | Disable Liftoff Wasm baseline compiler |
| `--no-wasm-tier-up` | Disable Wasm tier-up |
| `--turboshaft-wasm` | Enable Turboshaft Wasm pipeline |
| `--maglev` | Enable Maglev mid-tier compiler |
| `--experimental-wasm-*` | Enable experimental Wasm proposals |
| `--trace-gc-verbose` | Verbose GC logging |
| `--heap-snapshot-on-gc=0` | Force heap snapshots |

## Next steps

- Read [architecture.md](architecture.md) to understand how components fit together.
- Read [gc-fuzzing.md](gc-fuzzing.md) to specialize in GC bugs.
- Read [variant-analysis.md](variant-analysis.md) to scale one crash into many.
