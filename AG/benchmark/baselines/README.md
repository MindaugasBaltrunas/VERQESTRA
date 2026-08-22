# Baselines

Committed baseline documents (BENCH-8). One file per baseline, named after its
`baselineId`:

```text
AG/benchmark/baselines/<baselineId>.json
```

## What a file holds

The serialized form of `BaselineDocument`
(`src/domain/baseline/document.ts`): canonical JSON with a trailing newline, so
the same baseline written twice is the same file and a diff between two
baselines is a diff of what they measured.

| Field | What it is |
|---|---|
| `manifest` | The immutable methodology statement: suite / config / policy hashes, AG commit, model settings, adapter versions, verifier version, OS and Node environment. |
| `manifestHash` | `sha256:` digest of the canonical manifest, rechecked on every read. |
| `samples` | Every stored run result the aggregates were computed from (BENCH-5). |
| `aggregates` | The BENCH-7 fold of `samples`, stored so the file stands on its own and rechecked so it cannot drift from them. |

## Rules

- **A baseline is immutable.** Correcting one means recording a new baseline with
  a new `baselineId`, not editing a file. A hand-edited record fails the manifest
  hash or the aggregate check and is refused on the next read — by design: a
  baseline that can be edited is not evidence.
- **A baseline is created through the application layer**
  (`createBaselineDocument`), never by hand. Creation refuses a run that carries
  no AG commit, a sample the schema rejects, or a timestamp that is not UTC.
- **A comparison is refused before it is reported.** Two baselines are compared
  only when their required methodology fields match; anything else is
  `inconclusive` with the differing field named
  (`src/domain/baseline/compatibility.ts`). A different host is recorded as a
  limitation instead — it weakens a comparison rather than invalidating it.

## Committed baselines

Two are committed: `2026-08-09-bb566c6f6bb8.json` and `2026-08-10-bb566c6f6bb8.json`.
Both hold `deterministic-control` samples only — the control calls no model, so
neither carries token telemetry and neither is a cost baseline for `ag-loop` or
`agent-solo`.

**Both are refused by the current build**, and deliberately so. They declare
manifest schema version 1, and this build reads version 2
(`BASELINE_MANIFEST_SCHEMA_VERSION`). Version 1 is exactly the set of baselines
recorded while the cost metric summed `input + output` and excluded cache
creation — a different quantity under the same name. The gate refuses them by
`unsupportedManifestSchema` and names the version, which is the intended
outcome: the alternative is a report presenting two incomparable numbers as a
delta. They are kept rather than deleted because a refused baseline is still the
record of what was measured, and `metricsVersion` in the manifest now makes the
next such redefinition refuse by field rather than by schema.

Recording a comparable baseline requires a full suite run, which is the
manual/scheduled workflow BENCH-12 keeps out of PR CI.
