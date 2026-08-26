// VQ-504 (23/N) testai — darbo įrodymo paieška. Grynoji dalis (grep argumentai) testuojama
// tiesiogiai; intervalo taisyklė — per attempt rezoliucijos portą, be git repo.
//
// Kertinė savybė: be ĮRODOMO šio task'o starto pagrindo langas yra TUŠČIAS, o ne visa istorija.
// Melagingas įrodymas uždarytų niekada neįgyvendintą užduotį ir atrakintų jos priklausinius.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AttemptResolutionPort } from "../infrastructure/state/attempt-resolution.js";
import { noRuntimeAttemptResolution } from "../infrastructure/state/attempt-resolution.js";
import {
  EVIDENCE_RANGE_NONE,
  taskEvidenceRangeArgs,
  taskWorkEvidenceGrepArgs,
} from "../infrastructure/git/work-evidence.js";

/**
 * runtimeRoot BE globalaus veidrodžio.
 *
 * Testai, tikrinantys „be bazės — tuščias langas", privalo neturėti nė vieno bazės šaltinio.
 * Rodant juos į tikrą `vq/`, jie praeitų dėl atsitiktinio `task_id` nesutapimo, o ne dėl tikrinamos
 * taisyklės.
 */
const NO_MIRROR = path.join(tmpdir(), "vq-work-evidence-no-mirror-DOES-NOT-EXIST");

/** runtimeRoot su globaliu veidrodžiu — tokiu, kokį rašo `recordTaskStartStatus`. */
async function runtimeRootWithMirror(baseline: unknown): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vq-mirror-"));
  await mkdir(path.join(root, "state"), { recursive: true });
  await writeFile(path.join(root, "state", "task-start-status.json"), JSON.stringify(baseline), "utf8");
  return root;
}

/** Attempt handle'o pakaitalas: intervalo taisyklei reikia TIK `readJson("task-start-status")`. */
function resolutionWith(baseline: unknown, ok = true): AttemptResolutionPort {
  return {
    resolveActiveAttempt: () =>
      Promise.resolve({
        ok: true,
        attempt: {
          handle: { readJson: () => Promise.resolve(ok ? { ok: true, data: baseline } : { ok: false, reason: "missing", errors: [] }) },
          manifest: {},
        },
      } as never),
  };
}

test("grep argumentai: paprastas id gauna tris šablonus, split vaikas — tik pilną", () => {
  const parent = taskWorkEvidenceGrepArgs("1210");
  assert.ok(parent?.includes("--grep=task 1210($|[^0-9-])"));
  assert.ok(parent?.includes("--grep=\\(1210\\)"));

  // Vaiko id ieškoma TIK pilna forma: kitaip tėvas pasisavintų vaiko darbą.
  const child = taskWorkEvidenceGrepArgs("1210-02-slug");
  assert.deepEqual(child, ["--extended-regexp", "--regexp-ignore-case", "--grep=1210-02-slug"]);
});

test("grep argumentai: id be numerio neturi jokio šablono", () => {
  assert.equal(taskWorkEvidenceGrepArgs("be-numerio"), undefined);
});

test("grep argumentai: numberIsUnique=true nekeičia elgesio (regresija)", () => {
  assert.deepEqual(taskWorkEvidenceGrepArgs("1210", true), taskWorkEvidenceGrepArgs("1210"));
  assert.deepEqual(taskWorkEvidenceGrepArgs("0042", true), taskWorkEvidenceGrepArgs("0042"));
});

test("grep argumentai: numberIsUnique=false palieka tik pilną id (numeris kartojasi eilėje)", () => {
  assert.deepEqual(taskWorkEvidenceGrepArgs("1210", false), [
    "--extended-regexp",
    "--regexp-ignore-case",
    "--grep=1210",
  ]);
});

test("grep argumentai: split vaikas nepriklauso nuo numberIsUnique — visada tik pilnas id", () => {
  const expected = ["--extended-regexp", "--regexp-ignore-case", "--grep=1210-02-slug"];
  assert.deepEqual(taskWorkEvidenceGrepArgs("1210-02-slug"), expected);
  assert.deepEqual(taskWorkEvidenceGrepArgs("1210-02-slug", true), expected);
  assert.deepEqual(taskWorkEvidenceGrepArgs("1210-02-slug", false), expected);
});

test("grep argumentai: id be numerio lieka undefined nepriklausomai nuo numberIsUnique", () => {
  assert.equal(taskWorkEvidenceGrepArgs("be-numerio", false), undefined);
  assert.equal(taskWorkEvidenceGrepArgs("be-numerio", true), undefined);
});

test("grep argumentai: ERE metasimboliai escape'inami pažodžiui", () => {
  const args = taskWorkEvidenceGrepArgs("0042");
  assert.ok(args?.includes("--grep=0042"));

  const tricky = taskWorkEvidenceGrepArgs("0042-02-a+b(c)");
  assert.ok(tricky?.some((arg) => arg.includes("a\\+b\\(c\\)")), "regex metasimboliai negali likti gyvi");
});

test("be attempt bazės langas TUŠČIAS, o ne visa istorija", async () => {
  const args = await taskEvidenceRangeArgs({
    projectRoot: process.cwd(),
    runtimeRoot: NO_MIRROR,
    taskId: "0042",
    resolution: noRuntimeAttemptResolution,
  });
  assert.deepEqual(args, [EVIDENCE_RANGE_NONE]);
});

test("SVETIMO task'o bazė lango neatidaro", async () => {
  const args = await taskEvidenceRangeArgs({
    projectRoot: process.cwd(),
    runtimeRoot: NO_MIRROR,
    taskId: "0042",
    resolution: resolutionWith({ task_id: "0099", base_head: "abc1234" }),
  });
  assert.deepEqual(args, [EVIDENCE_RANGE_NONE]);
});

test("netinkamos formos base_head lango neatidaro", async () => {
  for (const base of ["", "   ", "ne-sha", "abc"]) {
    const args = await taskEvidenceRangeArgs({
      projectRoot: process.cwd(),
      runtimeRoot: NO_MIRROR,
      taskId: "0042",
      resolution: resolutionWith({ task_id: "0042", base_head: base }),
    });
    assert.deepEqual(args, [EVIDENCE_RANGE_NONE], `base_head=${JSON.stringify(base)}`);
  }
});

test("neegzistuojantis commit'as lango neatidaro net su teisinga forma", async () => {
  // Forma tinkama, bet tokio objekto repo nėra — `rev-parse --verify` tai pagauna.
  const args = await taskEvidenceRangeArgs({
    projectRoot: process.cwd(),
    runtimeRoot: NO_MIRROR,
    taskId: "0042",
    resolution: resolutionWith({ task_id: "0042", base_head: "0123456789abcdef0123456789abcdef01234567" }),
  });
  assert.deepEqual(args, [EVIDENCE_RANGE_NONE]);
});

// ---------------------------------------------------------------------------
// globalus veidrodis: „normali" no-runtime būsena nebeuždaro lango
// ---------------------------------------------------------------------------

test("bandymo namespace NEPASIEKIAMAS, bet veidrodis turi bazę — langas ATSIDARO", async () => {
  // 2026-08-25 regresija: kiekvienas dispatch'as buvo `no-runtime`, skaitytojas žiūrėjo TIK į
  // bandymo namespace'ą, tad langas visada likdavo `HEAD..HEAD` ir `hasWorkEvidence` niekada
  // negalėjo tapti `true` — visi `ALREADY_IMPLEMENTED` task'ai krito į human-review.
  const { run } = await import("../infrastructure/process/run-process.js");
  const head = await run("git", ["-C", process.cwd(), "rev-parse", "HEAD"], { cwd: process.cwd() });
  if (head.code !== 0) return; // ne-git aplinkoje šis testas neturi ką tikrinti
  const sha = head.stdout.trim();

  const args = await taskEvidenceRangeArgs({
    projectRoot: process.cwd(),
    runtimeRoot: await runtimeRootWithMirror({ task_id: "0042", base_head: sha }),
    taskId: "0042",
    resolution: noRuntimeAttemptResolution,
  });
  assert.deepEqual(args, [`${sha}..HEAD`]);
});

test("veidrodis su SVETIMU task_id lango NEATIDARO — atsarginis kelias nieko neatlaisvina", async () => {
  const args = await taskEvidenceRangeArgs({
    projectRoot: process.cwd(),
    runtimeRoot: await runtimeRootWithMirror({ task_id: "0099", base_head: "a".repeat(40) }),
    taskId: "0042",
    resolution: noRuntimeAttemptResolution,
  });
  assert.deepEqual(args, [EVIDENCE_RANGE_NONE]);
});

test("sugadintas veidrodis nėra bazė — spėti draudžiama", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vq-mirror-broken-"));
  await mkdir(path.join(root, "state"), { recursive: true });
  await writeFile(path.join(root, "state", "task-start-status.json"), "{ not json", "utf8");

  const args = await taskEvidenceRangeArgs({
    projectRoot: process.cwd(),
    runtimeRoot: root,
    taskId: "0042",
    resolution: noRuntimeAttemptResolution,
  });
  assert.deepEqual(args, [EVIDENCE_RANGE_NONE]);
});

test("REALUS HEAD atidaro langą", async () => {
  const { run } = await import("../infrastructure/process/run-process.js");
  const head = await run("git", ["-C", process.cwd(), "rev-parse", "HEAD"], { cwd: process.cwd() });
  if (head.code !== 0) return; // ne-git aplinkoje šis testas neturi ką tikrinti

  const sha = head.stdout.trim();
  const args = await taskEvidenceRangeArgs({
    projectRoot: process.cwd(),
    runtimeRoot: NO_MIRROR,
    taskId: "0042",
    resolution: resolutionWith({ task_id: "0042", base_head: sha }),
  });
  assert.deepEqual(args, [`${sha}..HEAD`]);
});
