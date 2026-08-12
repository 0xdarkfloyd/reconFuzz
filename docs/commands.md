# Command Reference

## TypeScript generator

```bash
node dist/generator/index.js [options]
```

| Option | Description |
|---|---|
| `--mode {js-only,wasm-only,gc-only,hybrid}` | Generation mode (default: `hybrid`) |
| `--seed N` | Random seed |
| `--output PATH` | Write testcase to file instead of stdout |

Examples:

```bash
node dist/generator/index.js --mode js-only --seed 1
node dist/generator/index.js --mode gc-only --output tmp/gc.js
npm run generate -- --mode hybrid --output tmp/sample.js
```

## Python runner scripts

### `scripts/fuzz.py` — continuous fuzzing loop

```bash
python scripts/fuzz.py [options]
```

| Option | Default | Description |
|---|---|---|
| `--d8 PATH` | `~/v8/v8/out/fuzzbuild/d8` | d8 binary; dry-run if missing |
| `--corpus PATH` | `seeds/corpus` | Corpus directory |
| `--crashes PATH` | `seeds/crashes` | Crash directory |
| `--iterations N` | `100` | Number of iterations (`0` = run continuously until Ctrl+C) |
| `--batch-size N` | `4 x CPUs` | Tasks in flight per batch |
| `--workers N` | CPU count | Worker processes |
| `--mode {js-only,wasm-only,hybrid}` | `hybrid` | Generator mode |
| `--seed N` | random | Random seed |
| `--timeout SECONDS` | `10.0` | d8 timeout |
| `--scheduler-config PATH` | none | YAML scheduler config |
| `--replay-prob P` | `0.25` | Probability of selecting a corpus seed |
| `--crossover-prob P` | `0.5` | Fraction of replays using crossover |
| `--admission {gain,hash}` | `gain` | Corpus admission: retain on globally new edges (`gain`) or unseen exact coverage hash (`hash`) |
| `--exec {reprl,process}` | `reprl` | Execution backend: `reprl` keeps one persistent d8 per worker via the Fuzzilli REPRL protocol (fast; fixed flag set, per-testcase `// Flags` ignored); `process` spawns a fresh d8 per testcase and honors per-testcase flags (slow fallback) |

> **REPRL is the default.** It needs a Fuzzilli-instrumented build
> (`v8_fuzzilli=true`); the runner auto-falls-back to `process` otherwise.
> Throughput on a debug+dcheck+verify build is bounded by V8's per-execution
> cost; a release/ASAN build is dramatically faster.

Examples:

```bash
python scripts/fuzz.py --iterations 100 --mode hybrid
python scripts/fuzz.py --d8 ../third_party/v8/out/release/d8 --iterations 1000
# Continuous pipeline: fuzz until Ctrl+C, stats printed after every batch
python scripts/fuzz.py --d8 /path/to/d8 --iterations 0 --mode hybrid
```

### `scripts/fuzz_gc.py` — GC-focused loop

Same options as `fuzz.py` but uses `gc-only` generator mode and always adds
`--expose-gc`.

```bash
python scripts/fuzz_gc.py --d8 /path/to/d8 --iterations 500
```

### `scripts/import_corpus.py` — import POC directories

```bash
python scripts/import_corpus.py SOURCE_DIR [options]
```

| Option | Default | Description |
|---|---|---|
| `--corpus PATH` | `seeds/corpus` | Destination corpus |
| `--crashes PATH` | `seeds/crashes` | Destination crashes |
| `--extension EXT` | `.js` | File extension to import |

Examples:

```bash
python scripts/import_corpus.py ../big_sleep
python scripts/import_corpus.py ../lokihardt_jshitter --extension .js
```

### `scripts/reproduce.py` — run a single testcase

```bash
python scripts/reproduce.py [options]
```

| Option | Description |
|---|---|
| `--d8 PATH` | d8 binary |
| `--testcase PATH` | Testcase file |
| `--flags FLAGS` | Space-separated flags |

Example:

```bash
python scripts/reproduce.py \
  --d8 ../third_party/v8/out/release/d8 \
  --testcase tmp/sample.js
```

### `scripts/setup_v8.py` — build V8 from source

```bash
python scripts/setup_v8.py [options]
```

| Option | Default | Description |
|---|---|---|
| `--workdir PATH` | `third_party` | Checkout directory |
| `--branch BRANCH` | `main` | V8 branch |
| `--build-type {debug,release}` | `release` | Build type |
| `--jobs N` | auto | Parallel jobs |
| `--skip-build` | false | Sync only |
| `--no-clobber` | false | Keep existing workdir |

Example:

```bash
python scripts/setup_v8.py --workdir ../third_party --build-type release
```

## npm scripts

| Script | Command |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run watch` | Watch build |
| `npm test` | Run Jest tests |
| `npm run lint` | Run ESLint |
| `npm run format` | Format with Prettier |
| `npm run generate` | Run generator CLI |
| `npm run generate:gc` | Run generator in `gc-only` mode |
| `npm run mutate` | Run mutator CLI |

## Python dev commands

```bash
pytest
ruff check src/runner scripts tests
black --check src/runner scripts tests
mypy src/runner scripts
```
