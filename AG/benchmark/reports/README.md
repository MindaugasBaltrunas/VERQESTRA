# Generated benchmark reports

`pnpm --dir AG/benchmark benchmark:report` writes two files here:

| File | Contract |
|---|---|
| `benchmark-report.json` | The machine-readable report. Object keys are sorted; an unmeasured metric has **no key**. |
| `benchmark-report.md` | The same report for a reader. An unmeasured metric reads `n/a`. |

Both are rendered from a single `BenchmarkReportModel`
(`src/application/report/benchmark-report-model.ts`), so they cannot describe two
different runs. Everything they say — verdict, baseline and current run,
per-mode metric comparison, per-scenario statistics, reasons, limitations, source
hashes, reproduction command — comes from that one value (BENCH-10).

## Why the files are not committed

They are regenerated output, so `.gitignore` keeps them out of the history. The
report is deterministic: the same inputs produce byte-identical files, and the
inputs are traceable through the hashes the report carries. Committing a copy
would add a second, ageing answer to a question the ledger and the baseline can
already answer exactly.

## What the report is, and is not

- **Deterministic.** No generation timestamp, declared ordering everywhere, and
  one rounding (4 decimal places) applied once in the model rather than per
  format.
- **Not a gate.** `benchmark:report` exits `0` when it produced a report,
  whatever the verdict inside it. The gate is `ag benchmark compare`, whose exit
  code is the verdict's.
- **Free of secrets and paths.** The reproduction command is redacted and names a
  baseline by the placeholder `<baseline-document>`; the report identifies runs by
  their BENCH-8 hashes, never by a file location.
- **Honest about what it could not measure.** An empty ledger, a suite that did
  not validate, a missing `configHash`, inconclusive samples and a differing host
  each become a limitation. None of them is silently rendered as a zero.
