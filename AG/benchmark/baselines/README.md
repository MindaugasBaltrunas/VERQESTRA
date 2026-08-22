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

No baseline is committed yet: recording one requires a full suite run, which is
the manual/scheduled workflow BENCH-12 keeps out of PR CI.
