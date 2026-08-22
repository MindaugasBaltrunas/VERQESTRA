# Frozen scenario suite

The versioned set BENCH-2 requires. One file per scenario beside a manifest that
names the set as a whole.

| File | Contents |
|---|---|
| `suite.manifest.json` | `schemaVersion` and the semantic `version` of the scenario content. |
| `<id>.scenario.json` | Exactly one scenario. The file name repeats the scenario id so a diff is readable; only the `id` field is authoritative. |

## Freezing

The suite hash covers the manifest version and every scenario field, and nothing
else — not the file names, not their order on disk, not the line endings a
checkout happened to write. Editing any scenario therefore changes the hash, and
a changed hash makes every earlier sample incomparable by design (BENCH-8).

So: **do not edit a scenario in place to "improve" it.** Either add a new
scenario with a new id, or edit and bump `version` in the manifest, accepting
that the existing baseline is retired. `AG/benchmark/src/tests/scenario-suite.test.ts`
pins the current hash against `suite.lock.json`, so an unintended edit fails the
build instead of quietly re-identifying the suite.

## Coverage

Every category in `SCENARIO_CATEGORIES` is represented, including the three
where a correct agent produces nothing: `architecture-violation`,
`security-violation` and `impossible-task`. Those declare
`expectedOutcome: "rejected"`, name the paths a violation would have to touch in
`forbiddenPaths`, and allow only `README.md` — an agent may write down why it
refuses, and may not implement the thing it was asked for.

## Determinism

Every scenario declares `deterministic: false`. The work is done by a language
model in each of the three modes, so no single run is evidence; BENCH-9 requires
at least three repetitions before any verdict is drawn. The field is not a
prediction about difficulty — a one-line fix behind a red test is still executed
stochastically.

## Checks

A check command is an argument vector, never a shell string, and always names a
specific test file. Fixtures deliberately ship red test files as bug reports, so
`node --test test/` would be red on a clean checkout and would say nothing about
the agent's work.
