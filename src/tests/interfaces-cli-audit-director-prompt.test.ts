// 219-b-03 (P1-Dk3): audit-director prompt'o kelių vartas. Taisančiam agentui paduodamas tekstas nurodo, kur
// rašyti commit žinutę — ir tai privalo būti TIKRASIS Stop hook'o skaitomas failas `vq/logs/commit-msg.md`
// (`on-stop-context.ts`). Kelias be `vq/` prefikso nukreiptų agentą į failą, kurio niekas neskaito.
//
// `auditPrompt` yra privatus sąmoningai: eksportas, kurio vienintelis kvietėjas būtų testas, yra tik dar viena
// mirusio eksporto skylė. Todėl promptas fiksuojamas per `auditDirectorCommand` fake portus, kaip realiame kelyje.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { EMPTY_CHECK_COMMAND_CONTEXT } from "../domain/policies/check-command-allowlist.js";
import { qualityPolicySchema } from "../application/policy-governance/quality-policy.js";
import type { CliIo } from "../interfaces/cli/registry.js";
import { auditDirectorCommand, type AuditDirectorPorts } from "../interfaces/cli/audit/audit-director.js";

const ROOT = path.resolve("/repo");
const RUNTIME_ROOT = path.join(ROOT, "vq");

const POLICY = qualityPolicySchema.parse({
  task: { checks: ["pnpm typecheck"] },
  feature: { checks: [] },
  milestone: { checks: [] },
});

type PromptWorld = { ports: AuditDirectorPorts; prompts: string[] };

/** Pirma iteracija raudona (promptas sukuriamas), antra žalia (ciklas baigiasi 0). */
function promptWorld(): PromptWorld {
  const files = new Map<string, string>();
  const prompts: string[] = [];
  let iteration = 0;

  const ports: AuditDirectorPorts = {
    ensureDirs: async () => {},
    loadPolicy: async () => POLICY,
    commandContext: async () => EMPTY_CHECK_COMMAND_CONTEXT,
    runner: async (check) => ({
      code: iteration === 0 ? 1 : 0,
      stdout: `${check.display}: TS2345 tipo klaida`,
      stderr: "",
    }),
    writeTextFile: async (absolutePath, content) => {
      files.set(absolutePath.replace(/\\/g, "/"), content);
    },
    readTextFileIfExists: async (absolutePath) => files.get(absolutePath.replace(/\\/g, "/")),
    resolveModel: async (tier) => `claude-${tier}-5`,
    runAudit: async (prompt) => {
      prompts.push(prompt);
      iteration += 1;
      return 0;
    },
    agLog: async () => {},
    now: () => new Date("2026-09-05T00:00:00.000Z"),
  };

  return { ports, prompts };
}

const io: CliIo = { out: () => {}, error: () => {} };

test("auditDirectorCommand: taisančio agento promptas nurodo vq/logs/commit-msg.md, ne kelią be prefikso", async () => {
  const world = promptWorld();
  const exit = await auditDirectorCommand({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io });

  assert.equal(exit, 0, "raudona iteracija, po jos žalia — ciklas baigiasi sėkme");
  assert.equal(world.prompts.length, 1, "promptas sukuriamas tik nepavykusios iteracijos šakoje");

  const prompt = world.prompts[0] ?? "";
  assert.ok(prompt.includes("vq/logs/commit-msg.md"), "promptas rodo į vq/ runtime kelią");
  assert.doesNotMatch(prompt, /(^|[^/])logs\/commit-msg/, "be `vq/` prefikso promptas meluoja Stop hook'ui");
});
