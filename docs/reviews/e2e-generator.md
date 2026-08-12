# End-to-End Generator Validation

## Method

- Modes: `js-only`, `wasm-only`, `gc-only`, and `hybrid`.
- Seeds: `0-24` inclusive, 25 generated cases per mode and 100 cases total.
- Generation command: `node dist/generator/index.js --mode <mode> --seed <seed>`, with a 10-second generation limit per case.
- Parsing: `@babel/parser` with `sourceType: 'script'` and the `v8intrinsic` plugin. All generated cases were parsed.
- Execution sample: seeds `0`, `5`, `10`, `15`, and `20`, giving 5 cases per mode and 20 cases total.
- Engine: `/home/ken/v8/v8/out/fuzzbuild/d8`.
- Execution command: `timeout 5 <d8> <file>`, giving each sampled case a hard 5-second limit.
- Distinctness: unique SHA-256 source hashes divided by successfully generated cases.
- Abnormal classification: exit status `124` or `137` is `timeout`; any other nonzero status is `nonzero-exit`. Counts are aggregate only.

## Results

| Mode | Generated | Distinct output rate | Parse success rate | Exit-code histogram | Abnormal exits |
| --- | ---: | ---: | ---: | --- | --- |
| `js-only` | 25/25 | 100% (25/25) | 100% (25/25; 0 failures) | `0: 4`, `1: 1` | `nonzero-exit: 1` |
| `wasm-only` | 25/25 | 84% (21/25) | 100% (25/25; 0 failures) | `0: 4`, `1: 1` | `nonzero-exit: 1` |
| `gc-only` | 25/25 | 100% (25/25) | 100% (25/25; 0 failures) | `1: 5` | `nonzero-exit: 5` |
| `hybrid` | 25/25 | 100% (25/25) | 100% (25/25; 0 failures) | `0: 1`, `1: 4` | `nonzero-exit: 4` |

## Findings

Generation and parsing were healthy across all four modes: all 100 requested cases were produced and all 100 parsed successfully. Source diversity was complete for `js-only`, `gc-only`, and `hybrid`; `wasm-only` produced 21 distinct sources from 25 seeds.

In the bounded execution sample, `js-only` and `wasm-only` each completed successfully in 4 of 5 cases. `hybrid` completed successfully in 1 of 5 cases, while all 5 sampled `gc-only` cases returned a nonzero exit. Across all modes, 9 of 20 sampled cases exited with status `0` and 11 returned status `1`. There were no timeouts, missing commands, or start failures.
