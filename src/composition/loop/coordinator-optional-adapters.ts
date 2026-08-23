// Neprivalomi koordinatoriaus portai (manual DI, LAY-2): semantinė integracijos peržiūra,
// deterministiniai integracijos vartai ir preflight kritimo memo.
//
// „Neprivalomas" reiškia tik viena: be jų kelias lieka BAITAS Į BAITĄ toks pat, koks buvo iki jų
// atsiradimo — `review-required` rizika parkuojama į human-review, o ne tyliai patvirtinama.
// Prijungti juos galima būtent dabar, nes visi trys reikalauja konteksto (runtime šaknis, git
// revizijos, attempt rezoliucija), kurį kompozicija jau turi.
//
// Fail-closed pusė kiekviename: sugadintas vartų konfigas META (jis liečia KIEKVIENĄ eilės task'ą,
// tad tai infrastruktūros gedimas, ne vieno task'o parkas), o sugadintas memo įrašas grąžina
// `corrupted` — memo negali nei patvirtinti, nei paneigti to, ko neperskaitė.

import path from "node:path";
import type {
  IntegrationGatePort,
  IntegrationPort,
  PreflightFailureMemoPort,
  PreflightFailureMemoReadResult,
} from "../../application/task-execution/run-coordinator-ports.js";
import { integrationVerifierPolicySchema, type IntegrationEnforcementMode } from "../../application/integration/wave-gates-schema.js";
import { preflightFailureMemoRecordSchema } from "../../application/quality-gates/preflight-memo-schema.js";
import type { ContractRevisionFile } from "../../application/integration/task-integration-evidence.js";
import { PolicyConfigError } from "../../shared/errors.js";
import { createIntegrationReviewPort } from "../../infrastructure/adapters/integration-review-adapter.js";
import { activeAttemptResolution } from "../../infrastructure/state/active-attempt.js";
import { run } from "../../infrastructure/process/run-process.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { toPrettyJson, tryParseJson } from "../../shared/json.js";

export type CoordinatorOptionalAdapterInput = {
  projectRoot: string;
  runtimeRoot: string;
};

/** `vq/state/preflight-failure-memo/<task_id>.json` — vienas failas vienam task'ui. */
function memoPath(runtimeRoot: string, taskId: string): string {
  return path.join(runtimeRoot, "state", "preflight-failure-memo", `${taskId}.json`);
}

/** Semantinė integracijos peržiūra su TIKRA attempt rezoliucija (telemetrijai, be `create`). */
export function integrationReviewPort(input: CoordinatorOptionalAdapterInput): IntegrationPort {
  return createIntegrationReviewPort({
    runtimeRoot: input.runtimeRoot,
    resolution: activeAttemptResolution({ projectRoot: input.projectRoot, runtimeRoot: input.runtimeRoot }),
  });
}

/**
 * Deterministiniai integracijos vartai: vykdymo režimas ir kontraktų turinys dviejose revizijose.
 *
 * Nesantis konfigas reiškia `advisory` — vartų ĮJUNGIMAS yra operatoriaus sprendimas. Bet
 * SUGADINTAS konfigas meta: klaidingai užrašytas režimas (`enfore`) privalo skambėti, o ne tyliai
 * išjungti vartus.
 */
export function integrationGatePort(input: CoordinatorOptionalAdapterInput): IntegrationGatePort {
  return {
    async mode(): Promise<IntegrationEnforcementMode> {
      const file = path.join(input.runtimeRoot, "config", "integration-verifier.json");
      const raw = await nodeFsAdapter.readTextFileIfExists(file);
      if (raw === undefined) return "advisory";

      const parsed = tryParseJson<unknown>(raw);
      if (!parsed.ok) throw new PolicyConfigError(file, parsed.error);
      const validated = integrationVerifierPolicySchema.safeParse(parsed.value);
      if (!validated.success) {
        throw new PolicyConfigError(file, new Error(validated.error.issues.map((issue) => issue.message).join("; ")));
      }
      return validated.data.mode;
    },

    async readContractFile(ref, filePath): Promise<ContractRevisionFile> {
      // `present: false` be teksto reiškia „revizijoje failo NEBUVO" — tai skiriasi nuo tuščio
      // failo, ir vartai iš to sprendžia apie kontrakto atsiradimą ar dingimą.
      const shown = await run("git", ["show", `${ref}:${filePath}`], { cwd: input.projectRoot, timeoutMs: 30_000 });
      return shown.code === 0 ? { present: true, text: shown.stdout } : { present: false };
    },
  };
}

/**
 * Preflight kritimo memo.
 *
 * `corrupted` yra ATSKIRA būsena nuo `absent`: nesamas memo reiškia „ankstesnio kritimo nebuvo", o
 * neperskaitomas — „buvo, bet nežinome koks". Sulieti juos reikštų, kad sugadintas failas tyliai
 * atrakina kelią, kurį memo turėjo pristabdyti.
 */
export function preflightFailureMemoPort(input: CoordinatorOptionalAdapterInput): PreflightFailureMemoPort {
  return {
    async read(taskId): Promise<PreflightFailureMemoReadResult> {
      const raw = await nodeFsAdapter.readTextFileIfExists(memoPath(input.runtimeRoot, taskId));
      if (raw === undefined) return { status: "absent" };

      const parsed = tryParseJson<unknown>(raw);
      if (!parsed.ok) return { status: "corrupted", errors: [parsed.error.message] };
      const validated = preflightFailureMemoRecordSchema.safeParse(parsed.value);
      return validated.success
        ? { status: "hit", record: validated.data }
        : { status: "corrupted", errors: validated.error.issues.map((issue) => issue.message) };
    },

    async record(entry): Promise<void> {
      const file = memoPath(input.runtimeRoot, entry.task_id);
      await nodeFsAdapter.makeDirectory(path.dirname(file));
      await nodeFsAdapter.writeTextFileAtomic(file, toPrettyJson(entry));
    },

    clear: (taskId) => nodeFsAdapter.removeIfExists(memoPath(input.runtimeRoot, taskId)).then(() => undefined),
  };
}
