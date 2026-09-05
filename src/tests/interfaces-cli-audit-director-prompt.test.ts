// 219-b-03 (audito radinys Dk3): `audit-director` promptas nurodo agentui, kur rašyti commit žinutę.
// Kelias turi būti TAS, kurį Stop hook'as tikrai skaito — `vq/logs/commit-msg.md` (`on-stop-context.ts`,
// `on-stop.ts`). Bare `logs/commit-msg.md` nuvestų agentą į repo šaknį, ir autorinė žinutė būtų praleista.
//
// Promptas fiksuojamas per fake portus, ne per privatų renderį: taip testas mato TĄ tekstą, kurį gauna
// agentas, o ne artimą jo kopiją.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { EMPTY_CHECK_COMMAND_CONTEXT } from "../domain/policies/check-command-allowlist.js";
import { qualityPolicySchema } from "../application/policy-governance/quality-policy.js";
import { auditDirectorCommand, type AuditDirectorPorts } from "../interfaces/cli/audit/audit-director.js";

const ROOT = path.resolve("/repo");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const norm = (p: string): string => p.replace(/\\/g, "/");

/** Bare `logs/commit-msg` be `vq/` prefikso. `new RegExp` — kad `/` simbolių klasėje neliestų lint'o. */
const BARE_COMMIT_MSG = new RegExp("(^|[^/])logs/commit-msg");

const POLICY = qualityPolicySchema.parse({
  task: { checks: [{ cmd: "pnpm", args: ["test"] }] },
  feature: { checks: [] },
  milestone: { checks: [] },
});

/** Vienas raudonas ratas, tada žalias: tiksliai vienas `runAudit` kvietimas, kurio promptą fiksuojam. */
function capturingPorts(prompts: string[]): AuditDirectorPorts {
  const files = new Map<string, string>();
  let iteration = 0;
  return {
    ensureDirs: async () => {},
    loadPolicy: async () => POLICY,
    commandContext: async () => EMPTY_CHECK_COMMAND_CONTEXT,
    runner: async (check) => ({ code: iteration === 0 ? 1 : 0, stdout: `${check.display} išvestis`, stderr: "" }),
    writeTextFile: async (p, content) => {
      files.set(norm(p), content);
    },
    readTextFileIfExists: async (p) => files.get(norm(p)),
    resolveModel: async (tier) => `claude-${tier}-5`,
    runAudit: async (prompt) => {
      prompts.push(prompt);
      iteration += 1;
      return 0;
    },
    agLog: async () => {},
    now: () => new Date("2026-09-05T00:00:00.000Z"),
  };
}

test("auditDirectorCommand: agento promptas siunčia commit žinutę į vq/logs/commit-msg.md, ne į bare logs/", async () => {
  const prompts: string[] = [];
  const exit = await auditDirectorCommand({
    ports: capturingPorts(prompts),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io: { out: () => {}, error: () => {} },
  });

  assert.equal(exit, 0);
  assert.equal(prompts.length, 1, "raudona pirma iteracija privalo pakviesti taisantį agentą");
  const prompt = prompts[0] ?? "";
  // Abi kryptys: kelias privalo BŪTI (eilutės ištrynimas testo nepraeitų) ir privalo turėti `vq/` prefiksą.
  assert.ok(prompt.includes("vq/logs/commit-msg.md"), "promptas privalo nurodyti realų Stop hook'o kelią");
  assert.doesNotMatch(prompt, BARE_COMMIT_MSG);
});
