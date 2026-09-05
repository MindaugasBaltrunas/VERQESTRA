// `audit-director` CLI adapteris (etalonas: interfaces/cli/audit-director/index.ts).
// Savarankiškas auditas: paleidžia sukonfigūruotas kokybės patikras, surašo raportą ir, kol
// lieka iteracijų, atiduoda jį taisančiam agentui. Grandinė nenaudojama — tai standalone
// komanda, ne agentų seka.
//
// Patikros eina per TĄ PAČIĄ komandų politiką, kurią taiko quality-gates use-case'as: abu
// keliai vykdo tai, ką deklaruoja `vq/config/quality-policy.json`, tad patikra, kurią politika
// ten atmeta, privalo būti atmesta ir čia — kitaip `audit-director` būtų neapsaugotas antras
// vykdymo kelias tam pačiam projekto redaguojamam konfigui.
//
// VERQESTRA skirtumas nuo etalono: visi efektai (katalogai, politika, procesų paleidimas,
// raporto rašymas, modelio rezoliucija, agento kvietimas, žurnalas) ateina per
// `AuditDirectorPorts`; handleris grąžina exit kodą.

import path from "node:path";
import type { CheckCommandContext } from "../../../domain/policies/check-command-allowlist.js";
import {
  evaluateShellQualityCommand,
  evaluateSpawnQualityCommand,
} from "../../../domain/policies/quality-command-policy.js";
import {
  resolveQualityChecks,
  type QualityPolicy,
  type ResolvedQualityCheck,
} from "../../../application/policy-governance/quality-policy.js";
import type { QualityGateRunner } from "../../../application/quality-gates/quality-gates.js";
import { consoleCliIo, type CliIo } from "../registry.js";

const MAX_ITERATIONS = 3;

/** Vienos audito patikros lubos. Auditas leidžia pilną suite'ą, tad jos plačios sąmoningai. */
const AUDIT_CHECK_TIMEOUT_MS = 30 * 60 * 1000;

/** Exit kodas patikrai, kurią atmetė komandų politika (etalono 126 — „negalima vykdyti"). */
const BLOCKED_CHECK_EXIT_CODE = 126;

export type AuditCheckResult = { name: string; cmd: string; code: number; output: string };

export type AuditDirectorPorts = {
  ensureDirs(): Promise<void>;
  loadPolicy(): Promise<QualityPolicy>;
  /** Komandų politikos kontekstas (configured checks + aktyvūs stack'ai); fail-safe — adapteryje. */
  commandContext(policy: QualityPolicy): Promise<CheckCommandContext>;
  runner: QualityGateRunner;
  writeTextFile(absolutePath: string, content: string): Promise<void>;
  /** Raporto turinys arba `undefined`, kai failo nėra (etalono readTextIfExists). */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  /** Pakopa -> realus modelio ID (models.env pusė). */
  resolveModel(tier: string): Promise<string>;
  /** Vienas taisančio agento paleidimas; grąžina vaiko exit kodą. */
  runAudit(prompt: string, model: string): Promise<number>;
  agLog(line: string): Promise<void>;
  now?(): Date;
};

export type AuditDirectorDeps = {
  ports: AuditDirectorPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot: string;
  io?: CliIo;
};

/** Audito raporto kelias — viena vieta abiem pusėms (rašymui ir spausdinamai eilutei). */
export function auditReportPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "logs", "audit-report.md");
}

async function runChecks(
  ports: AuditDirectorPorts,
  checks: { name: string; check: ResolvedQualityCheck }[],
  context: CheckCommandContext,
  projectRoot: string,
): Promise<AuditCheckResult[]> {
  return await Promise.all(
    checks.map(async ({ name, check }) => {
      const cmd = check.display;
      const policyResult =
        check.kind === "shell"
          ? evaluateShellQualityCommand(check.display, context)
          : evaluateSpawnQualityCommand(check.cmd, check.args, context);
      if (policyResult.blockedPattern) {
        return {
          name,
          cmd,
          code: BLOCKED_CHECK_EXIT_CODE,
          output: `Audit check blocked by ${check.kind} policy: ${policyResult.blockedPattern}`,
        };
      }

      const result = await ports.runner(check, projectRoot, AUDIT_CHECK_TIMEOUT_MS);
      return { name, cmd, code: result.code, output: `${result.stdout}${result.stderr}`.trim() };
    }),
  );
}

/** Raporto tekstas — grynas renderis, kad testai jį pin'intų be failų sistemos. */
export function renderAuditReport(
  results: readonly AuditCheckResult[],
  iteration: number,
  projectRoot: string,
  generatedAt: string,
): string {
  const lines = [
    `# Audit Report — iteracija ${iteration}`,
    `- data: ${generatedAt}`,
    `- projektas: ${projectRoot}`,
    `- praeina: ${results.filter((r) => r.code === 0).map((r) => r.name).join(", ") || "nė vienas"}`,
    `- nepraėjo: ${results.filter((r) => r.code !== 0).map((r) => r.name).join(", ") || "nė vienas"}`,
    "",
  ];
  for (const result of results) {
    lines.push(`## ${result.name} — ${result.code === 0 ? "✅ PRAEINA" : `❌ NEPRAĖJO (exit ${result.code})`}`);
    lines.push(`Komanda: \`${result.cmd}\``);
    if (result.output) {
      lines.push("```");
      lines.push(result.output.slice(0, 8000));
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

function auditPrompt(iteration: number, report: string): string {
  return [
    `# Audit Director — iteracija ${iteration}`,
    "",
    `Perskaityk šį audit raportą ir pataisyk visas klaidas:\n\n${report}`,
    "",
    "Taisymo taisyklės:",
    "- TypeScript error TS → rask failą, pataisyk tipo klaidą",
    "- ESLint error → pataisyk lint pažeidimą",
    "- Test FAIL → rask root cause, taisyk produkcinį kodą",
    "- Nenaudok @ts-ignore ar eslint-disable",
    "- Nekeisk business logikos, DB schemos ar public API",
    "",
    // `vq/` prefiksas privalomas: Stop hook'as skaito BŪTENT `vq/logs/commit-msg.md` (`on-stop-context.ts`).
    "Kai visos klaidos pataisytos, įrašyk commit žinutę į vq/logs/commit-msg.md ir sustok.",
  ].join("\n");
}

export async function auditDirectorCommand(deps: AuditDirectorDeps): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const ports = deps.ports;
  await ports.ensureDirs();

  const policy = await ports.loadPolicy();
  const model = await ports.resolveModel("sonnet");
  const reportFile = auditReportPath(deps.runtimeRoot);

  const commandContext = await ports.commandContext(policy);
  const checks = resolveQualityChecks(policy, "task").map((check, index) => ({
    name: `task-${index + 1}`,
    check,
  }));

  io.out("AG Loop Audit Director");
  io.out("=".repeat(40));

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    io.out("");
    io.out(`Iteracija ${iteration}/${MAX_ITERATIONS} — tikrinimų paleidimas...`);
    await ports.agLog(`AUDIT ITERATION ${iteration}/${MAX_ITERATIONS}: running checks`);

    const results = await runChecks(ports, checks, commandContext, deps.projectRoot);
    const generatedAt = (ports.now?.() ?? new Date()).toISOString();
    await ports.writeTextFile(reportFile, renderAuditReport(results, iteration, deps.projectRoot, generatedAt));

    const failed = results.filter((result) => result.code !== 0);
    if (failed.length === 0) {
      io.out("");
      io.out("AUDIT ✅ — visos patikros praeina");
      await ports.agLog("AUDIT PASSED");
      return 0;
    }

    io.out(`Nepraėjo: ${failed.map((result) => result.name).join(", ")} — raportas: ${reportFile}`);

    if (iteration === MAX_ITERATIONS) {
      io.out("");
      io.out(`AUDIT ❌ — iteracijų limitas (${MAX_ITERATIONS}) pasiektas`);
      await ports.agLog("AUDIT FAILED: max iterations reached");
      return 1;
    }

    io.out("");
    io.out(`Paleidžiamas audit-director agentas (iteracija ${iteration})...`);
    await ports.agLog(`AUDIT: dispatching claude iteration ${iteration} model=${model}`);

    const report = (await ports.readTextFileIfExists(reportFile)) ?? "";
    const exitCode = await ports.runAudit(auditPrompt(iteration, report), model);
    await ports.agLog(`AUDIT: claude finished iteration ${iteration} exit=${exitCode}`);

    if (exitCode !== 0 && exitCode !== 1) {
      io.out(`Claude paleidimo klaida (exit ${exitCode}). Tikrink ar claude CLI įdiegtas.`);
      return exitCode;
    }
  }

  // Ciklas visada baigiasi viena iš grąžinimo šakų viduje; ši eilutė yra tik TS išsamumui.
  return 1;
}
