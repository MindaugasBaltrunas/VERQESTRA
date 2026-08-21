// Kokybės vartų ir audito klasterio adapteriai (manual DI, LAY-2).
//
// Šio klasterio ypatybė: jis VYKDO projekto redaguojamas komandas (`vq/config/quality-policy.json`)
// ir paleidžia taisantį agentą. Todėl vienintelis vykdymo kelias yra
// `infrastructure/process/quality-check-runner` — antra, privati vykdymo kopija būtent ir buvo
// ta spraga, per kurią etalono audito kelias leido shell patikras be komandų politikos.

import path from "node:path";
import {
  loadQualityPolicy,
  resolveCheckCommandContext,
  type CheckContextProfileView,
  type QualityPolicy,
} from "../application/policy-governance/quality-policy.js";
import { loadContextBudget } from "../application/policy-governance/context-budget.js";
import { loadPreflightLimits } from "../application/policy-governance/preflight-limits-policy.js";
import { loadTaskClassificationPolicy } from "../application/policy-governance/task-classification-policy.js";
import { loadAgentPolicy } from "../application/policy-governance/agent-policy.js";
import {
  loadArchitectureStylePolicy,
  loadCodingPrinciplesPolicy,
  loadEnforcementPolicy,
} from "../application/policy-governance/architecture-policies.js";
import {
  type PreflightDecision,
  type PreflightPolicies,
  type PreflightPorts,
} from "../application/quality-gates/preflight.js";
import { checkCodeIndexFreshness } from "../application/code-intelligence/store/code-index-store.js";
import type { CheckCommandContext } from "../domain/policies/check-command-allowlist.js";
import type { AuditDirectorPorts } from "../interfaces/cli/audit/audit-director.js";
import { loadModelsEnv, normalizeModelTier, resolveModelTier } from "../infrastructure/adapters/claude-model-env.js";
import type { QualityGatesPorts } from "../application/quality-gates/quality-gates.js";
import { checksLogPath, qualityGatesStatusPath } from "../application/quality-gates/quality-gates-status.js";
import { parseEnvFile } from "../interfaces/http/ui-port-store.js";
import { runClaudeHeadless } from "../infrastructure/adapters/claude-headless.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { resolveExistingDispatchTaskFile } from "../infrastructure/state/dispatch-task-file.js";
import { runQualityCheck } from "../infrastructure/process/quality-check-runner.js";
import { ensureRuntimeDirs } from "../infrastructure/state/runtime-dirs.js";
import { appendLogLine } from "./loop-adapters.js";
import { codeIntelligenceFs, policyConfigFs } from "./node-adapters.js";
import { toPrettyJson, tryParseJson } from "../shared/json.js";

/**
 * Projekto profilis komandų politikos kontekstui.
 *
 * Trūkstamas ar sugadintas profilis duoda `undefined`, o ne klaidą: aktyvių stack'ų nežinojimas
 * susiaurina LEIDŽIAMŲ komandų aibę (tuščias `activeStacks`), tad fail-safe kryptis čia yra
 * saugi — nežinomas stack'as neįgyja teisės ko nors paleisti.
 */
async function readProfileView(runtimeRoot: string): Promise<CheckContextProfileView | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "project", "profile.json"));
  if (raw === undefined) return undefined;
  const parsed = tryParseJson<CheckContextProfileView>(raw);
  return parsed.ok && parsed.value !== null && typeof parsed.value === "object" ? parsed.value : undefined;
}

/** Komandų politikos kontekstas: deklaruotos spawn patikros plius projekto stack'ai. */
export async function checkCommandContext(
  runtimeRoot: string,
  policy: QualityPolicy | undefined,
): Promise<CheckCommandContext> {
  return resolveCheckCommandContext(policy, await readProfileView(runtimeRoot));
}

/** Pakopa → realus modelio ID iš `vq/config/models.env`. */
export async function resolveModelForTier(runtimeRoot: string, tier: string): Promise<string> {
  return resolveModelTier(normalizeModelTier(tier), await loadModelsEnv(runtimeRoot));
}

/** Kiek laiko duodama vienai audito patikrai (etalono 30 min riba). */
export const AUDIT_CHECK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * `audit-director`: patikros, raportas, modelis ir taisančio agento paleidimas.
 *
 * `runAudit` grąžina vaiko exit kodą, o ne meta: komanda pati skiria „agentas rado problemų"
 * (0/1) nuo „agento paleisti nepavyko" (bet koks kitas kodas), ir tik antruoju atveju nutraukia
 * iteracijas. Išimtis tą skirtumą sunaikintų.
 */
export function auditDirectorPorts(projectRoot: string, runtimeRoot: string, agRoot: string): AuditDirectorPorts {
  return {
    ensureDirs: () => ensureRuntimeDirs(agRoot, runtimeRoot),
    loadPolicy: () => loadQualityPolicy(policyConfigFs, runtimeRoot),
    commandContext: (policy) => checkCommandContext(runtimeRoot, policy),
    runner: (check, cwd, timeoutMs, env) => runQualityCheck(check, cwd, timeoutMs ?? AUDIT_CHECK_TIMEOUT_MS, env),
    writeTextFile: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    resolveModel: (tier) => resolveModelForTier(runtimeRoot, tier),
    runAudit: async (prompt, model) => {
      // State katalogas — runtime šaknyje, o ne projekto medyje: win32 šakoje ten atsiranda
      // prompt'o tmp failas, ir projekto kataloge jis atrodytų kaip agento darbas.
      const stateDir = path.join(runtimeRoot, "state");
      await nodeFsAdapter.makeDirectory(stateDir);
      const previousCwd = process.cwd();
      try {
        process.chdir(projectRoot);
        return (await runClaudeHeadless(prompt, model, stateDir)).code;
      } finally {
        process.chdir(previousCwd);
      }
    },
    agLog: (line) => appendLogLine(runtimeRoot, "orchestrator.log", line),
  };
}

/**
 * `quality-gates` portai.
 *
 * Ta pati komandų politika ir tas pats vykdytojas kaip audito direktoriaus kelyje — vartai,
 * kurie leistų kitokias komandas nei auditas, būtų du skirtingi „praėjo".
 *
 * MEMO SĄMONINGAI NEPADUODAMAS: jo adapteris (git medžio tapatybė per laikiną indeksą + dist
 * turinio hash) dar nemigruotas, o memo be tapatybės būtų arba tylus praleidimas, arba melagingas
 * „hit". Be jo vartai tiesiog visada bėga — konservatyvi pusė.
 */
export function qualityGatesPorts(runtimeRoot: string): QualityGatesPorts {
  return {
    loadPolicy: () => loadQualityPolicy(policyConfigFs, runtimeRoot),
    commandContext: (policy) => checkCommandContext(runtimeRoot, policy),
    runner: (check, cwd, timeoutMs, env) => runQualityCheck(check, cwd, timeoutMs ?? AUDIT_CHECK_TIMEOUT_MS, env),
    writeStatus: (status) => nodeFsAdapter.writeTextFile(qualityGatesStatusPath(runtimeRoot), toPrettyJson(status)),
    writeChecksLog: (text) => nodeFsAdapter.writeTextFile(checksLogPath(runtimeRoot), text),
    // Klaida čia yra TUŠČIAS rinkinys, ne lūžis: trūkstamas lokalus konfigas neturi sustabdyti
    // vartų, kurie ir be jo turi ką patikrinti.
    loadLocalEnv: async () => {
      const raw = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "config", "local.env"));
      return raw === undefined ? {} : parseEnvFile(raw);
    },
  };
}

/**
 * `preflight` politikos — septyni krautuvai vienu pjūviu.
 *
 * Krovimas LYGIAGRETUS, bet klaida NENUTYLIMA: bet kurio konfigo gedimas nutraukia preflight'ą.
 * Tai sąmoninga — sprendimas, priimtas be vienos politikos, atrodytų kaip pilnas sprendimas,
 * o būtent preflight yra vieta, kur task'ui dar galima pasakyti „ne".
 */
export async function preflightPolicies(runtimeRoot: string): Promise<PreflightPolicies> {
  const [limits, budget, classificationPolicy, agentPolicy, architectureStylePolicy, codingPrinciplesPolicy, enforcementPolicy] =
    await Promise.all([
      loadPreflightLimits(policyConfigFs, runtimeRoot),
      loadContextBudget(policyConfigFs, runtimeRoot),
      loadTaskClassificationPolicy(policyConfigFs, runtimeRoot),
      loadAgentPolicy(policyConfigFs, runtimeRoot),
      loadArchitectureStylePolicy(policyConfigFs, runtimeRoot),
      loadCodingPrinciplesPolicy(policyConfigFs, runtimeRoot),
      loadEnforcementPolicy(policyConfigFs, runtimeRoot),
    ]);
  return {
    limits,
    budget,
    classificationPolicy,
    agentPolicy,
    architectureStylePolicy,
    codingPrinciplesPolicy,
    enforcementPolicy,
  };
}

/**
 * `preflight`: task failo rezoliucija, politikos, spec šaltinių patikra, indekso šviežumas
 * ir sprendimo persistencija.
 *
 * `resolveTaskFile` eina per dispatch adreso taisyklę: preflight'as vertina TIK tai, ką loop'as
 * galėtų realiai dispatch'inti. Laisvas kelias leistų patvirtinti failą, esantį už eilės ribų,
 * ir sprendimas nurodytų task'ą, kurio niekas niekada nepaims.
 */
export function preflightPorts(projectRoot: string, runtimeRoot: string): PreflightPorts {
  return {
    resolveTaskFile: async (taskArg: string) => {
      const filePath = await resolveExistingDispatchTaskFile(projectRoot, taskArg);
      return { filePath, text: await nodeFsAdapter.readTextFile(filePath) };
    },
    loadPolicies: () => preflightPolicies(runtimeRoot),
    statPathKind: async (absolutePath: string) => {
      const kind = await nodeFsAdapter.statKind(absolutePath);
      return kind === "file" || kind === "directory" ? kind : "absent";
    },
    codeIndexFreshness: () => checkCodeIndexFreshness(codeIntelligenceFs(projectRoot), projectRoot),
    // Kelias deklaruotas porto komentare (`vq/supervisor/preflight-decision.json`), bet
    // use case'as jo funkcijos neeksportuoja — sudaromas čia, vienoje vietoje.
    writeDecision: (decision: PreflightDecision) =>
      nodeFsAdapter.writeTextFile(
        path.join(runtimeRoot, "supervisor", "preflight-decision.json"),
        toPrettyJson(decision),
      ),
  };
}
