// VQ-504 (23/N) testai — darbo įrodymo paieška. Grynoji dalis (grep argumentai) testuojama
// tiesiogiai; intervalo taisyklė — per attempt rezoliucijos portą, be git repo.
//
// Kertinė savybė: be ĮRODOMO šio task'o starto pagrindo langas yra TUŠČIAS, o ne visa istorija.
// Melagingas įrodymas uždarytų niekada neįgyvendintą užduotį ir atrakintų jos priklausinius.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttemptResolutionPort } from "../infrastructure/state/attempt-resolution.js";
import { noRuntimeAttemptResolution } from "../infrastructure/state/attempt-resolution.js";
import {
  EVIDENCE_RANGE_NONE,
  taskEvidenceRangeArgs,
  taskWorkEvidenceGrepArgs,
} from "../infrastructure/git/work-evidence.js";

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

test("grep argumentai: ERE metasimboliai escape'inami pažodžiui", () => {
  const args = taskWorkEvidenceGrepArgs("0042");
  assert.ok(args?.includes("--grep=0042"));

  const tricky = taskWorkEvidenceGrepArgs("0042-02-a+b(c)");
  assert.ok(tricky?.some((arg) => arg.includes("a\\+b\\(c\\)")), "regex metasimboliai negali likti gyvi");
});

test("be attempt bazės langas TUŠČIAS, o ne visa istorija", async () => {
  const args = await taskEvidenceRangeArgs({
    projectRoot: process.cwd(),
    taskId: "0042",
    resolution: noRuntimeAttemptResolution,
  });
  assert.deepEqual(args, [EVIDENCE_RANGE_NONE]);
});

test("SVETIMO task'o bazė lango neatidaro", async () => {
  const args = await taskEvidenceRangeArgs({
    projectRoot: process.cwd(),
    taskId: "0042",
    resolution: resolutionWith({ task_id: "0099", base_head: "abc1234" }),
  });
  assert.deepEqual(args, [EVIDENCE_RANGE_NONE]);
});

test("netinkamos formos base_head lango neatidaro", async () => {
  for (const base of ["", "   ", "ne-sha", "abc"]) {
    const args = await taskEvidenceRangeArgs({
      projectRoot: process.cwd(),
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
    taskId: "0042",
    resolution: resolutionWith({ task_id: "0042", base_head: "0123456789abcdef0123456789abcdef01234567" }),
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
    taskId: "0042",
    resolution: resolutionWith({ task_id: "0042", base_head: sha }),
  });
  assert.deepEqual(args, [`${sha}..HEAD`]);
});
