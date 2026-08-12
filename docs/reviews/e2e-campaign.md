# E2E Campaign Metrics

## METHOD

This report summarizes a bounded batch that was executed in a prior step. The values below were read from the neutral summary generated from its captured log; the batch was not executed again for this report. The requested configuration was 60 iterations across 2 workers in hybrid mode. The recorded execution mode was `reprl`, and the admission mode was the default, `gain`. The configured target binary path was `/home/ken/v8/v8/out/fuzzbuild/d8`, with a wall-clock cap of 240 seconds. Measurements in this report are limited to the aggregate fields printed by the neutral summary.

## METRICS

| Summary field | Printed value |
| --- | ---: |
| `exec_mode_used` | `reprl` |
| `reprl_to_process_fallback` | `no` |
| `iterations_completed` | `60` |
| `worker_errors` | `0` |
| `abnormal_exit_total` | `0` |
| `daemon_restarts` | `0` |
| `seeds_admitted_to_corpus` | `60` |
| `retained_output_entries` | `0` |
| `abnormal_exit_neutral_breakdown` | `timeout: 0; nonzero-exit: 0` |
| `timeout` | `0` |
| `nonzero-exit` | `0` |
| `loop_executed_to_completion` | `yes` |
| `wrapper_exit` | `unknown` |

The table preserves the neutral summary values as printed. The `abnormal_exit_neutral_breakdown` row identifies the aggregate breakdown category, while the following `timeout` and `nonzero-exit` rows retain each printed component as an independently readable measurement. The wrapper exit value is reported as `unknown`; no additional status is inferred from that field. Completion is assessed from the separately printed loop-completion metric.

## FINDINGS

- The batch loop ran to completion: `loop_executed_to_completion` was `yes`, and `iterations_completed` matched the 60 requested iterations.
- The batch admitted new outputs to the corpus: `seeds_admitted_to_corpus` was 60. The separate `retained_output_entries` measurement was 0, so no equivalence between corpus admissions and retained output entries is inferred.
- The background service met the stated health criterion: `daemon_restarts` was 0 during the captured run.
- No worker errors were recorded: `worker_errors` was 0 across the two-worker batch.
- No nonzero exits were recorded. The neutral abnormal-exit breakdown reported `nonzero-exit` as 0 and `timeout` as 0, consistent with `abnormal_exit_total` of 0.

Overall, the aggregate measurements show that all requested iterations completed, corpus admission occurred, the background service required no recorded restart, and the summary recorded neither worker errors nor abnormal exits. This conclusion is based only on the neutral summary from the previously captured batch log and does not add assumptions about internal batch behavior.
