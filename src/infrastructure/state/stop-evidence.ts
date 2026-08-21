// Attempt-first stop įrodymo skaitytojas (etalonas: orchestrator/runtime/context.ts
// `readStopEvidence`, task 0042). Vienintelė vieta, kur sujungiami DU šaltiniai: šio bandymo
// `<attempt>/stop-state.json` ir globalus veidrodis `vq/state/claude-stop-status.json`.
//
// Svarbiausia taisyklė: sugadintas ATTEMPT artefaktas NENUSILEIDŽIA prie legacy veidrodžio.
// Bandymas turi savo įrodymą, ir tylus grįžimas prie globalaus failo grąžintų būtent tą
// last-writer-wins priklausomybę, kurią attempt namespace'as naikina — todėl toks atvejis
// pažymimas `corrupted`, o sprendimą priimantis kelias renkasi konservatyvią šaką.
//
// Griežtumo asimetrija sąmoninga: attempt šaka validuojama `stopStateSchema` (vienintelis jos
// rašytojas — stop-bridge — rašo per tą pačią schemą), legacy šaka tikrina tik JSON sintaksę,
// nes jos rašytojų istoriškai buvo daugiau ir pre-hardening įrašuose trūksta laukų.

import { toError } from "../../shared/errors.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import type { AttemptResolutionPort } from "./attempt-resolution.js";
import { stopBridgePath, stopStateSchema } from "./stop-bridge.js";

/** Įrodymo kilmė — operatoriui matoma reikšmė, ne vidinė detalė. */
export type StopEvidenceOrigin = "attempt" | "legacy" | "none";

export type StopEvidenceSnapshot = {
  origin: StopEvidenceOrigin;
  /** Dokumento tekstas taip, kaip jį matytų operatorius; tuščias, kai įrodymo nėra. */
  raw: string;
  /**
   * VISAS įrašas, nesusiaurintas iki `{status, reason}`: `task_id`, `head`, `git_status` yra
   * vienintelis būdas operatoriui pamatyti, KODĖL įrodymas laikytas svetimu.
   */
  record: Record<string, unknown>;
  status?: string;
  reason?: string;
  /** Įraše užfiksuotas task id; legacy pre-hardening faile jo gali nebūti. */
  taskId?: string;
  /** Įrodymas rastas, bet neparsinamas — sprendimas privalo eiti konservatyviu keliu. */
  corrupted: boolean;
  /** Absoliutus kelias, iš kurio įrodymas paimtas; `undefined`, kai nieko nerasta. */
  path?: string;
  /** Neblokuojantys nukrypimai (pvz. nepasiekiamas namespace) — kviečiantysis juos loguoja. */
  warnings: string[];
};

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** Legacy veidrodžio šaka: tik JSON sintaksė, jokios schemos. */
function fromLegacy(raw: string, filePath: string, warnings: string[]): StopEvidenceSnapshot {
  if (!raw.trim()) {
    return { origin: "none", raw, record: {}, corrupted: false, path: filePath, warnings };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { origin: "legacy", raw, record: {}, corrupted: true, path: filePath, warnings };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { origin: "legacy", raw, record: {}, corrupted: true, path: filePath, warnings };
  }
  const record = parsed as Record<string, unknown>;
  const status = stringField(record, "status");
  const reason = stringField(record, "reason");
  const taskId = stringField(record, "task_id");
  return {
    origin: "legacy",
    raw,
    record,
    ...(status === undefined ? {} : { status }),
    ...(reason === undefined ? {} : { reason }),
    ...(taskId === undefined ? {} : { taskId }),
    corrupted: false,
    path: filePath,
    warnings,
  };
}

export type StopEvidenceInput = {
  runtimeRoot: string;
  resolution: AttemptResolutionPort;
  taskId: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Perskaito stop įrodymą. NIEKADA nemeta: skaitytoją kviečia diagnostikos paviršiai (status,
 * diagnose, SSE), į kuriuos kreipiamasi BŪTENT tada, kai kažkas sulūžę — griuvimas ten atimtų
 * paskutinį įrankį, kuriuo galima pamatyti, kas atsitiko.
 */
export async function readStopEvidence(input: StopEvidenceInput): Promise<StopEvidenceSnapshot> {
  const warnings: string[] = [];
  const legacyPath = stopBridgePath(input.runtimeRoot);

  try {
    if (input.taskId.trim() !== "") {
      const resolved = await input.resolution.resolveActiveAttempt(input.taskId, input.env);
      if (resolved.ok) {
        const read = await resolved.attempt.handle.readJson("stop-state", stopStateSchema);
        if (read.ok) {
          return {
            origin: "attempt",
            raw: `${JSON.stringify(read.data, null, 2)}\n`,
            record: read.data,
            status: read.data.status,
            reason: read.data.reason,
            taskId: read.data.task_id,
            corrupted: false,
            path: read.path,
            warnings,
          };
        }
        if (read.reason === "invalid-json" || read.reason === "schema") {
          return {
            origin: "attempt",
            raw: "",
            record: {},
            corrupted: true,
            warnings: [`attempt stop-state unreadable task=${input.taskId} reason=${read.reason}`],
          };
        }
        // `missing` yra normali būsena (Stop hook'as dar nesuveikė šiame bandyme) — be įspėjimo.
        if (read.reason !== "missing") {
          warnings.push(`attempt stop-state unavailable task=${input.taskId} reason=${read.reason}`);
        }
      }
    }

    const raw = await nodeFsAdapter.readTextFileIfExists(legacyPath);
    if (raw === undefined) {
      // Failo nėra — Stop hook'as dar nesuveikė. Tai NE korupcija.
      return { origin: "none", raw: "", record: {}, corrupted: false, path: legacyPath, warnings };
    }
    return fromLegacy(raw, legacyPath, warnings);
  } catch (error: unknown) {
    // IO klaida yra „nežinau", ne „įrodymo nėra": kviečiantysis privalo matyti skirtumą.
    return {
      origin: "none",
      raw: "",
      record: {},
      corrupted: true,
      path: legacyPath,
      warnings: [...warnings, `stop evidence read failed: ${toError(error).message}`],
    };
  }
}
