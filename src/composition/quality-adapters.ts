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
import type { CheckCommandContext } from "../domain/policies/check-command-allowlist.js";
import type { AuditDirectorPorts } from "../interfaces/cli/audit/audit-director.js";
import { loadModelsEnv, normalizeModelTier, resolveModelTier } from "../infrastructure/adapters/claude-model-env.js";
import { runClaudeHeadless } from "../infrastructure/adapters/claude-headless.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { runQualityCheck } from "../infrastructure/process/quality-check-runner.js";
import { ensureRuntimeDirs } from "../infrastructure/state/runtime-dirs.js";
import { tryParseJson } from "../shared/json.js";
import { appendLogLine } from "./loop-adapters.js";
import { policyConfigFs } from "./node-adapters.js";

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
