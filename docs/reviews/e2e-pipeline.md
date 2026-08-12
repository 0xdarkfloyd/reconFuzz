# End-to-End Pipeline Validation

## Method

- Date: 2026-08-07 (UTC)
- Daemon: `dist/generator/server.js`, port `39123`; `/lift` readiness probe returned HTTP 200.
- Lift sample: 20 real `.js` seeds (13 from `seeds/big_sleep`, 7 from `seeds/lokihardt_jshitter`) plus 3 intentionally malformed fixtures.
- V8-native-syntax coverage: 6 of the 20 real seeds contained V8 intrinsic syntax.
- Mutation sample: 15 real seeds from the lift sample, one POST per seed.
- Crossover sample: 15 POSTs using real seeds as corpus bodies, paired with distinct deterministic numeric generation seeds accepted by the endpoint.
- Parse check: `@babel/parser` with `sourceType: "script"`, `allowReturnOutsideFunction`, `errorRecovery`, and `v8intrinsic` (plus the daemon's other parser plugins).
- Import wiring: a temporary source directory under `/tmp/e2e-pipe/` containing two copied real seeds and one malformed fixture; destination `/tmp/e2e-pipe/corpus`; daemon URL `http://127.0.0.1:39123`.
- No source files were edited and `npm run build` was not run.

## Metrics

| Area | Metric | Observed | Total | Rate |
|---|---|---:|---:|---:|
| `/lift` | HTTP 200 responses | 23 | 23 | 100% |
| `/lift` | `ok=true` (real + malformed) | 20 | 23 | 86.96% |
| `/lift` | `ok=false` / quarantined | 3 | 23 | 13.04% |
| `/lift` | `normalized` parsed | 20 | 20 | 100% |
| `/lift` | `normalized` differed from input | 20 | 20 | 100% |
| `/lift` | V8-intrinsic seeds accepted and parsed | 6 | 6 | 100% |
| `/mutate` | Outputs changed from input | 15 | 15 | 100% |
| `/mutate` | Outputs parsed | 15 | 15 | 100% |
| `/crossover` | Outputs changed from input | 15 | 15 | 100% |
| `/crossover` | Outputs parsed | 15 | 15 | 100% |
| `import_corpus` (first pass) | Newly added | 2 | 3 | 66.67% |
| `import_corpus` (first pass) | Already present | 0 | 3 | 0% |
| `import_corpus` (first pass) | Quarantined | 1 | 3 | 33.33% |
| `import_corpus` (repeat) | Newly added | 0 | 3 | 0% |
| `import_corpus` (repeat) | Already present | 2 | 3 | 66.67% |
| `import_corpus` (repeat) | Quarantined | 1 | 3 | 33.33% |
| Quarantine directory | Entries after import | 2 | 2 | 100% |

## Findings

- Classification: daemon ready; all requested endpoint calls completed with HTTP 200.
- Lifting accepted all 20 real seeds, including all 6 sampled V8-native-syntax seeds. Every accepted normalized output parsed under the configured Babel parser, and all accepted outputs were canonicalized relative to their submitted source.
- Mutation changed every sampled input and every returned output parsed.
- Crossover changed every sampled input and every returned output parsed.
- Malformed fixtures were rejected by `/lift` (3/3). The import run quarantined its malformed fixture (1/3) and added the two real seeds; a repeat run reported both valid seeds as already present.
- Cleanup: the daemon was stopped after measurements.
