// Stop hook'o tiltas orkestratoriui (etalonas: AG_loop orchestrator/state/stop-bridge.ts;
// task 0040 + 0056 + 2026-08-12 no-clobber incidentas). VERQESTRA keliai:
// vq/state/claude-stop-status.json, vq/logs/claude-stop.log, vq/logs/orchestrator.log.
// Attempt rezoliucija — per AttemptResolutionPort (pilnas resolveris atvyksta su loop E5).
//
// `dispatch_nonce` turi lygiai DVI roles: (1) VARTAI — tuščias nonce reiškia interaktyvią
// sesiją ir attempt artefaktas NERAŠOMAS; (2) ĮRAŠOMAS LAUKAS — attempt įrašui susieti su
// konkrečia sesija.

import path from "node:path";
import { z } from "zod";
import { toError } from "../../shared/errors.js";
import { toPrettyJson } from "../../shared/json.js";
import { validateWithSchema } from "../../shared/schema.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { gitHead, gitStatusResult } from "../git/git-client.js";
import type { RuntimeWriteFailure } from "../persistence/runtime-artifact-io.js";
import { writeAttemptJsonWithRetry } from "../persistence/runtime-artifact-store.js";
import type { AttemptResolutionFailure, AttemptResolutionPort } from "./attempt-resolution.js";

// Tikslus globalaus stop įrašo veidrodis attempt namespace'e. `schema_version` SĄMONINGAI
// nėra: dokumentas apibrėžiamas kaip to paties lauko rinkinio kopija, o additive
// evoliucijos kelią duoda looseObject + CAS revision (etalono kontraktas).
export const stopStateSchema = z.looseObject({
  date: z.string().min(1),
  /** Tyčia NE enum: naujas statusas neturi tapti schema read failure. */
  status: z.string().min(1),
  /** Gali būti tuščias: bridge argumentas defaultina į "". */
  reason: z.string().default(""),
  task_id: z.string().min(1),
  /** Niekada tuščias: tuščias nonce yra rašymo VARTAI, ne reikšmė. */
  dispatch_nonce: z.string().min(1),
  /** Tuščias ne-git projekte. */
  head: z.string().default(""),
  /** Tuščias, kai worktree švarus; sentinel `<git status failed: …>`, kai statusas nežinomas. */
  git_status: z.string().default(""),
  /** Nustatytas TIK kai `git status` nepavyko — skaitytojui signalas, kad `git_status` yra sentinel, ne tuščias medis. */
  git_status_error: z.string().optional(),
});
export type StopState = z.infer<typeof stopStateSchema>;

export function stopBridgePath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "claude-stop-status.json");
}

function timestampLine(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export type AttemptStopStateInput = {
  runtimeRoot: string;
  resolution: AttemptResolutionPort;
  taskId: string;
  status: string;
  reason: string;
  /** Ta pati ISO reikšmė, kurią gauna globalus veidrodis — vienas laikrodžio skaitymas. */
  date: string;
  head: string;
  gitStatus: string;
  /** Nustatytas TIK kai `git status` nepavyko (žr. `gitStatusResult`). */
  gitStatusError?: string;
  env?: NodeJS.ProcessEnv;
};

export type AttemptStopStateOutcome =
  | { ok: true; path: string }
  | {
      ok: false;
      reason: "no-nonce" | "no-task-id" | "invalid-payload" | AttemptResolutionFailure | RuntimeWriteFailure;
      errors: string[];
    };

/**
 * Priežastys, kurios yra NORMALI būsena, ne incidentas — jos nelogeriamos, kad stop kelias
 * neužterštų žurnalo kiekvienoje interaktyvioje sesijoje. Deny-list, ne allow-list: bet
 * kokia NAUJA priežastis pagal nutylėjimą yra matoma.
 */
const SILENT_STOP_STATE_REASONS: ReadonlySet<string> = new Set([
  "no-nonce",
  "no-task-id",
  "disabled",
  "no-runtime",
  "not-created",
]);

async function warnStopState(runtimeRoot: string, message: string): Promise<void> {
  await nodeFsAdapter
    .appendTextFile(path.join(runtimeRoot, "logs", "orchestrator.log"), `[${timestampLine()}] ${message}\n`)
    .catch(() => undefined);
}

async function attemptStopStateOutcome(input: AttemptStopStateInput): Promise<AttemptStopStateOutcome> {
  const env = input.env ?? process.env;
  const nonce = (env["AG_DISPATCH_NONCE"] ?? "").trim();
  if (nonce === "") return { ok: false, reason: "no-nonce", errors: ["no AG_DISPATCH_NONCE: interactive session"] };
  const taskId = input.taskId.trim();
  if (taskId === "") return { ok: false, reason: "no-task-id", errors: ["no active task id recorded"] };

  try {
    // `create:false` semantika: stop įrodymas yra telemetrija — namespace'ą kuria tik
    // preflight/diagnose.
    const resolved = await input.resolution.resolveActiveAttempt(taskId, env);
    if (!resolved.ok) return { ok: false, reason: resolved.reason, errors: resolved.errors };

    const payload = validateWithSchema(stopStateSchema, {
      date: input.date,
      status: input.status,
      reason: input.reason,
      task_id: taskId,
      dispatch_nonce: nonce,
      head: input.head,
      git_status: input.gitStatus,
      ...(input.gitStatusError === undefined ? {} : { git_status_error: input.gitStatusError }),
    });
    if (!payload.ok) return { ok: false, reason: "invalid-payload", errors: payload.errors };

    // Validuota reikšmė (su defaults) yra tai, kas atsiduria diske.
    const stopState: StopState = payload.data;
    const written = await writeAttemptJsonWithRetry(resolved.attempt.handle, "stop-state", stopState);
    if (!written.ok) return { ok: false, reason: written.reason, errors: written.errors };
    return { ok: true, path: written.value.path };
  } catch (error: unknown) {
    return { ok: false, reason: "store", errors: [toError(error).message] };
  }
}

/**
 * Rašo attempt-scoped stop įrodymą. NIEKADA nemeta: stop kelias privalo baigtis net kai
 * runtime namespace nepasiekiamas — riba aplink VISĄ kūną, nes kelias kviečiamas iš dist
 * Stop hook'o, kur netipizuota įvestis taptų TypeError ir sugriautų globalų veidrodį.
 */
export async function writeAttemptStopState(input: AttemptStopStateInput): Promise<AttemptStopStateOutcome> {
  try {
    const outcome = await attemptStopStateOutcome(input);
    if (!outcome.ok && !SILENT_STOP_STATE_REASONS.has(outcome.reason)) {
      await warnStopState(
        input.runtimeRoot,
        `WARNING: stop-state attempt artifact skipped task=${input.taskId} reason=${outcome.reason}: ${outcome.errors.join("; ")}`,
      );
    }
    return outcome;
  } catch (error: unknown) {
    return { ok: false, reason: "store", errors: [toError(error).message] };
  }
}

/**
 * Ar interaktyvios (be nonce) sesijos stop gali perrašyti esamą globalų bridge įrašą.
 *
 * 2026-08-12 incidentas: interaktyvi sesija ir dispatch'as dalinasi VIENU statuso failu,
 * tad interaktyvūs Stop hook'ai trynė dispatch'o „done" įrodymą. Taisyklė: dispatch'o
 * įrašas (ne tuščias `dispatch_nonce`) yra STIPRESNIS — jį perrašyti gali tik kitas
 * dispatch rašytojas. Tik iš tarpų sudarytas nonce NEĮRODO gyvo dispatch'o; sugadintas
 * failas nieko neįrodo — perrašymas jį tik pagerina.
 */
export function interactiveStopMayOverwrite(existingRaw: string): boolean {
  if (!existingRaw.trim()) return true;
  try {
    const parsed = JSON.parse(existingRaw) as { dispatch_nonce?: unknown };
    return typeof parsed.dispatch_nonce !== "string" || parsed.dispatch_nonce.trim() === "";
  } catch {
    return true;
  }
}

/** Rašymo VARTAI (022-a-02): statusas, kuriuo pažymimas pasenusio nonce rašytojo įrašas. */
export const STOP_BRIDGE_STALE_STATUS = "stale";

/** Jau tilte gulinčio įrašo `dispatch_nonce`, arba `""`, kai tilto nėra/sugadintas/tuščias. */
function existingBridgeNonce(existingRaw: string): string {
  if (!existingRaw.trim()) return "";
  try {
    const parsed = JSON.parse(existingRaw) as { dispatch_nonce?: unknown };
    return typeof parsed.dispatch_nonce === "string" ? parsed.dispatch_nonce.trim() : "";
  } catch {
    return "";
  }
}

export async function stopBridgeForProject(input: {
  projectRoot: string;
  runtimeRoot: string;
  resolution: AttemptResolutionPort;
  status: string;
  reason: string;
  taskId: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}): Promise<void> {
  const { projectRoot, runtimeRoot, status, reason, taskId } = input;
  const logsDir = path.join(runtimeRoot, "logs");
  const head = (await gitHead(projectRoot)) ?? "";
  const statusResult = await gitStatusResult(projectRoot);
  // Nesėkmė (index.lock, EPERM, ne repo) NĖRA švarus medis: sentinel įrašas neleidžia
  // skaitytojui, kuris tikrina „git_status === '' => švaru", tyliai praeiti (fail closed).
  const git_status = statusResult.ok ? statusResult.status : `<git status failed: ${statusResult.detail}>`;
  const git_status_error = statusResult.ok ? undefined : statusResult.detail;
  const date = (input.now ?? (() => new Date().toISOString()))();
  // Tas pats env IR ta pati skaitymo taisyklė abiem rašytojams: nonce triminamas lygiai
  // kaip attempt vartuose — vien iš tarpų sudarytas AG_DISPATCH_NONCE abiejose vietose
  // skaitomas kaip interaktyvi sesija (kitaip pseudo-dispatch įrašas liktų amžinas).
  const dispatch_nonce = ((input.env ?? process.env)["AG_DISPATCH_NONCE"] ?? "").trim();

  const bridgeFile = stopBridgePath(runtimeRoot);
  const existingRaw = (await nodeFsAdapter.readTextFileIfExists(bridgeFile).catch(() => "")) ?? "";

  // No-clobber vartai (2026-08-12): interaktyvi sesija nenaikina dispatch'o įrodymo.
  // Ankstyvas return praleidžia ir attempt rašymą (interaktyviai sesijai jis ir taip
  // no-op per no-nonce vartą), o claude-stop.log gauna PRESERVED eilutę.
  if (dispatch_nonce === "") {
    if (!interactiveStopMayOverwrite(existingRaw)) {
      await nodeFsAdapter.appendTextFile(
        path.join(logsDir, "claude-stop.log"),
        `[${timestampLine()}] CLAUDE STOP BRIDGE PRESERVED: dispatch irasas paliktas, interaktyvus stop (status=${status}) jo neperraso\n`,
      );
      return;
    }
  }

  // 022-a-02: jei šio rašytojo nonce nebesutampa su tuo, kuris jau tilte įrašytas, kitas
  // dispatch'as jau perėmė šį globalų slot'ą tarp mano paleidimo ir šio Stop įvykio — mano
  // įrodymas atvyksta VĖLUODAMAS. `status=done` čia būtų klaidingas „aš baigiau" signalas;
  // `STOP_BRIDGE_STALE_STATUS` palieka įrašą matomą, bet nepretenduoja į done reikšmę
  // (classifyStopBridgeDone bet kokį ne-"done" statusą jau traktuoja kaip "none", ne
  // lipnų "foreign-done").
  const priorNonce = dispatch_nonce === "" ? "" : existingBridgeNonce(existingRaw);
  const isStaleDispatchWrite = dispatch_nonce !== "" && priorNonce !== "" && priorNonce !== dispatch_nonce;
  const bridgeStatus = isStaleDispatchWrite ? STOP_BRIDGE_STALE_STATUS : status;

  // TVARKA YRA KONTRAKTAS: globalus `status=done` yra watchdog'o KILL trigger'is, tad
  // attempt artefaktas rašomas PIRMAS — kitaip watchdog gali pradėti grace skaičiavimą,
  // kol įrodymas dar nerašytas. Ateities optimizacija tvarkos apversti negali.
  await writeAttemptStopState({
    runtimeRoot,
    resolution: input.resolution,
    taskId,
    status: bridgeStatus,
    reason,
    date,
    head,
    gitStatus: git_status,
    ...(git_status_error === undefined ? {} : { gitStatusError: git_status_error }),
    ...(input.env === undefined ? {} : { env: input.env }),
  });

  // ATOMIŠKAI (task 0056), ne paprastu writeFile: watchdog'as failą pollina ir skaito RAW
  // regex'u — dalinai įrašytas failas lange gali sutapti su viena sąlyga be kitos.
  // nodeFsAdapter.writeTextFile = unikalus tmp + rename su win32 retry (etalono
  // writeJsonAtomicRetrying atitikmuo); baitai — toPrettyJson forma, kontraktas nekinta.
  await nodeFsAdapter.writeTextFile(
    bridgeFile,
    // F7: task_id pririša statusą prie task'o, kuris buvo aktyvus Stop metu; dispatch_nonce
    // leidžia watchdog'ui atskirti SAVO „done" nuo svetimo (2026-08-04 incidentas: 12
    // zero-usage avarijų per dieną, kai interaktyvios sesijos „done" žudė svetimą dispatch).
    toPrettyJson({
      date,
      status: bridgeStatus,
      reason,
      task_id: taskId,
      dispatch_nonce,
      head,
      git_status,
      ...(git_status_error === undefined ? {} : { git_status_error }),
    }),
  );
  await nodeFsAdapter.appendTextFile(
    path.join(logsDir, "claude-stop.log"),
    `[${timestampLine()}] CLAUDE STOP BRIDGE status=${bridgeStatus} reason=${reason}\n`,
  );
}
