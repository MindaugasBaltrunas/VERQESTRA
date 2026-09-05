// Preserved-ref retencija (task 075-a-02): `refs/verqestra/preserved/<commit>` gyvena kaip
// GC apsauga (žr. `rollback-scope.ts` `preserveTaskScope`), bet niekada savaime nedingsta —
// be šio modulio jie kauptųsi amžinai. Ref'as trinamas TIK kai jo task'as yra `done`, senesnis
// už retencijos ribą IR `.json` įrašas nesako `recovered=false` (recovery review dar
// neuždarytas arba nepavyko — trynimas tada prarastų vienintelį darbo pėdsaką).
//
// Sprendimas (`evaluatePreservedRefRetention`) yra grynas — jokio IO, testuojamas be git ar
// failų sistemos. Orkestracija (`expirePreservedRefs`) skaito `.json` įrašus iš
// `vq/state/rollback-preserved/`, task'o bucket'ą iš `AG/tasks/<bucket>/<id>.md` egzistavimo,
// ir vykdo `update-ref -d` + `.json` pašalinimą TIK po sėkmingo sprendimo.
//
// Prijungimas prie priežiūros ciklo, ref'ų trynimas rollback metu, `git gc`/`reflog expire`
// ir hooks.log rotacija — už šio modulio ribų (žr. task'o `## Neįtraukta`).

import path from "node:path";
import { taskBuckets } from "../../domain/tasks/buckets.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { gitRefExists } from "./git-client.js";
import { run } from "../process/run-process.js";
import { PRESERVED_REF_PREFIX } from "./rollback-scope.js";
import { PRESERVED_REF_RECORD_DIRNAME, type PreservedRefRecord } from "./preserved-ref-record-model.js";
import {
  reconcilePreservedRefs,
  type PreservedRefReconcileResult,
} from "./preserved-ref-reconcile.js";

export const PRESERVED_REF_RETENTION_DEFAULT_DAYS = 14;

export type PreservedRefTaskStatus = "done" | "not-done" | "unknown";

export type PreservedRefRetentionInput = {
  taskId: string;
  ref: string;
  recordedAt: string;
  recovered: boolean | undefined;
  taskStatus: PreservedRefTaskStatus;
  now: Date;
  retentionDays?: number;
};

export type PreservedRefRetentionDecision =
  | { expire: true; ageDays: number; logLine: string }
  | {
      expire: false;
      reason: "not-done" | "unknown-task-status" | "too-young" | "recovered-false" | "invalid-recorded-at" | "invalid-ref-prefix";
    };

function ageDaysSince(recordedAt: string, now: Date): number | undefined {
  const recordedMs = Date.parse(recordedAt);
  if (Number.isNaN(recordedMs)) return undefined;
  return (now.getTime() - recordedMs) / (24 * 60 * 60 * 1000);
}

/**
 * Grynas sprendimas: ar konkretus preserved ref'as jau peržengė retencijos ribą.
 *
 * `ref` privalo gyventi po {@link PRESERVED_REF_PREFIX} — apsauga nuo sugadinto ar
 * suklastoto `.json` įrašo, nurodančio SVETIMĄ ref'ą: `update-ref -d` yra destruktyvus
 * bet kokiam ref'ui, tad kvietėjas privalo šią patikrą turėti PRIEŠ trindamas.
 */
export function evaluatePreservedRefRetention(input: PreservedRefRetentionInput): PreservedRefRetentionDecision {
  if (!input.ref.startsWith(PRESERVED_REF_PREFIX)) return { expire: false, reason: "invalid-ref-prefix" };
  if (input.taskStatus === "unknown") return { expire: false, reason: "unknown-task-status" };
  if (input.taskStatus !== "done") return { expire: false, reason: "not-done" };
  if (input.recovered === false) return { expire: false, reason: "recovered-false" };

  const ageDays = ageDaysSince(input.recordedAt, input.now);
  if (ageDays === undefined) return { expire: false, reason: "invalid-recorded-at" };

  const retentionDays = input.retentionDays ?? PRESERVED_REF_RETENTION_DEFAULT_DAYS;
  if (ageDays <= retentionDays) return { expire: false, reason: "too-young" };

  const roundedAge = Math.floor(ageDays);
  return {
    expire: true,
    ageDays: roundedAge,
    logLine: `PRESERVED REF EXPIRED: ${input.ref} task=${input.taskId} age=${roundedAge}`,
  };
}

async function locateTaskBucket(projectRoot: string, taskId: string): Promise<PreservedRefTaskStatus> {
  for (const bucket of taskBuckets) {
    const candidate = path.join(projectRoot, "AG", "tasks", bucket, `${taskId}.md`);
    if (await nodeFsAdapter.exists(candidate)) {
      return bucket === "done" ? "done" : "not-done";
    }
  }
  return "unknown";
}

type StoredPreservedRefRecord = { recordPath: string; record: PreservedRefRecord };

async function readPreservedRefRecords(runtimeRoot: string): Promise<StoredPreservedRefRecord[]> {
  const dir = path.join(runtimeRoot, "state", PRESERVED_REF_RECORD_DIRNAME);
  const names = (await nodeFsAdapter.listFiles(dir)).filter((name) => name.endsWith(".json"));
  const records: StoredPreservedRefRecord[] = [];

  for (const name of names) {
    const recordPath = path.join(dir, name);
    const raw = await nodeFsAdapter.readTextFileIfExists(recordPath);
    if (raw === undefined) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // korumpuotas įrašas — praleidžiamas, ne trinamas (fail-closed).
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const candidate = parsed as Partial<PreservedRefRecord>;
    if (
      typeof candidate.task_id !== "string" ||
      typeof candidate.ref !== "string" ||
      typeof candidate.recorded_at !== "string"
    ) {
      continue;
    }

    records.push({
      recordPath,
      record: {
        task_id: candidate.task_id,
        ref: candidate.ref,
        commit: typeof candidate.commit === "string" ? candidate.commit : "",
        base_ref: typeof candidate.base_ref === "string" ? candidate.base_ref : "",
        paths: Array.isArray(candidate.paths) ? candidate.paths.filter((entry): entry is string => typeof entry === "string") : [],
        recorded_at: candidate.recorded_at,
        ...(typeof candidate.recovered === "boolean" ? { recovered: candidate.recovered } : {}),
      },
    });
  }

  return records;
}

async function deleteGitRef(root: string, ref: string): Promise<boolean> {
  const result = await run("git", ["-C", root, "update-ref", "-d", ref]);
  return result.code === 0;
}

export type PreservedRefRetentionPorts = {
  agLog(line: string): Promise<void>;
  now?: () => Date;
};

export type PreservedRefExpiryOutcome = { taskId: string; ref: string; ageDays: number };
export type PreservedRefKeptOutcome = { taskId: string; ref: string; reason: string };

export type PreservedRefRetentionResult = {
  expired: PreservedRefExpiryOutcome[];
  kept: PreservedRefKeptOutcome[];
  /** 197: šio bėgimo sutaikinimo rezultatas; nėra tik tada, kai sutaikinimas metė klaidą. */
  reconciled?: PreservedRefReconcileResult;
};

export type PreservedRefRetentionOptions = {
  runtimeRoot?: string;
  retentionDays?: number;
};

/**
 * Peržiūri visus `.json` įrašus `vq/state/rollback-preserved/` ir pašalina pasenusius
 * `refs/verqestra/preserved/<sha>` kartu su jų įrašais. Kiekvienas žingsnis fail-closed:
 * dingęs ref'as arba nepavykęs `update-ref -d`/failo trynimas palieka įrašą kitam bėgimui,
 * o ne trina tyliai iš dalies.
 *
 * PIRMAS žingsnis (197) — sutaikinimas: be jo našlaitis ref'as (be `.json`) šiai retencijai
 * apskritai neegzistuoja, tad kauptųsi amžinai. Sutaikinimas įrašą atkuria dar prieš
 * `readPreservedRefRecords`, tad TAS PATS bėgimas jį jau įvertina. Sutaikinimo nesėkmė
 * retencijos nestabdo: senesnis kelias veikė ir be jo.
 */
export async function expirePreservedRefs(
  projectRoot: string,
  ports: PreservedRefRetentionPorts,
  options: PreservedRefRetentionOptions = {},
): Promise<PreservedRefRetentionResult> {
  const root = path.resolve(projectRoot);
  const runtimeRoot = options.runtimeRoot ?? path.join(root, "vq");
  const now = ports.now?.() ?? new Date();

  const reconciled = await reconcileBeforeExpiry(root, runtimeRoot, ports);

  const expired: PreservedRefExpiryOutcome[] = [];
  const kept: PreservedRefKeptOutcome[] = [];

  for (const { recordPath, record } of await readPreservedRefRecords(runtimeRoot)) {
    const taskStatus = await locateTaskBucket(root, record.task_id);
    const decision = evaluatePreservedRefRetention({
      taskId: record.task_id,
      ref: record.ref,
      recordedAt: record.recorded_at,
      recovered: record.recovered,
      taskStatus,
      now,
      ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
    });

    if (!decision.expire) {
      kept.push({ taskId: record.task_id, ref: record.ref, reason: decision.reason });
      continue;
    }

    if (!(await gitRefExists(record.ref, root))) {
      kept.push({ taskId: record.task_id, ref: record.ref, reason: "ref-missing" });
      continue;
    }
    if (!(await deleteGitRef(root, record.ref))) {
      kept.push({ taskId: record.task_id, ref: record.ref, reason: "delete-failed" });
      continue;
    }

    try {
      await nodeFsAdapter.removeFile(recordPath);
    } catch {
      kept.push({ taskId: record.task_id, ref: record.ref, reason: "record-delete-failed" });
      continue;
    }

    await ports.agLog(decision.logLine);
    expired.push({ taskId: record.task_id, ref: record.ref, ageDays: decision.ageDays });
  }

  return { expired, kept, ...(reconciled === undefined ? {} : { reconciled }) };
}

/**
 * Sutaikinimas yra retencijos paruošiamasis žingsnis, o ne jos sąlyga. Git nesėkmes
 * `reconcilePreservedRefs` jau nuryja pats; čia lieka failų sistemos ir `agLog` klaidos —
 * jos nutildomos, o pranešimas apie tai savo ruožtu negali griūti antrą kartą (jei metė
 * būtent `agLog`, retencija vis tiek privalo tęsti).
 */
async function reconcileBeforeExpiry(
  root: string,
  runtimeRoot: string,
  ports: PreservedRefRetentionPorts,
): Promise<PreservedRefReconcileResult | undefined> {
  try {
    return await reconcilePreservedRefs(root, { agLog: async (line) => await ports.agLog(line) }, { runtimeRoot });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      await ports.agLog(`PRESERVED REF RECONCILE FAILED: ${detail} — retention continues`);
    } catch {
      // Jei būtent žurnalas ir buvo tai, kas nulūžo, retencija vis tiek tęsiasi.
    }
    return undefined;
  }
}
