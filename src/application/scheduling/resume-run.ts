// Crash recovery sprendimas wave scheduler'iui (task 1113; spec WAVE-2 „Resume MUST būti
// idempotentinis ir MUST NOT pakartoti jau priimto commit arba užbaigto task").
// Behaviour etalon: AG_loop application/scheduling/resume-run.ts (1:1).
//
// Modulis yra grynas: jokio FS, git ar laikrodžio. Visi „ar egzistuoja / ar yra commit"
// klausimai jau atsakyti iškvietėjo ir paduoti kaip `ResumeEvidence`, todėl kiekvieną
// sprendimą galima atkurti iš log'o eilutės ir padengti unit testu be darbinio medžio.
import { isSameTask, normalizeTaskReference } from "../../domain/tasks/dependencies.js";

/** Sprendimo TAISYKLIŲ versija — įrašoma į `reason`, kad seni log'ai liktų palyginami. */
export const RESUME_RULES_VERSION = 1;

/** Kur šiuo metu guli checkpoint'o task'as (nustato iškvietėjas, skenuodamas bucket'us). */
export type ResumeTaskLocation =
  /** active | delegated | error — nutrūkęs vykdymas, kurį moka tęsti resume kelias. */
  | "resumable-bucket"
  /** Task'as grąžintas į eilę — saugu dispatch'inti iš naujo. */
  | "queue"
  /** done | human-review | duplicate — lifecycle jau užvertas. */
  | "terminal-bucket"
  /** Failo nebėra nė viename bucket'e. */
  | "absent";

/** Checkpoint'o poaibis, kurio reikia sprendimui. */
export type ResumeCheckpointView = {
  actor?: string;
  phase?: string;
  status: "started" | "finished" | "failed" | "waiting" | "moved";
  task_id?: string;
  task_file?: string;
  run_id?: string;
  wave_id?: string;
  graph_hash?: string;
  attempt_id?: string;
  updated_at?: string;
};

export type ResumeEvidence = {
  /** Dabartinio grafo hash'as. Nesutapimas su checkpoint'o hash'u = stale checkpoint. */
  currentGraphHash?: string;
  location: ResumeTaskLocation;
  /**
   * Ar task'o darbas jau PRIIMTAS (commit pasiekiamas iš HEAD). Tai vienintelis įrodymas,
   * kuriuo remiantis galima teigti „šito kartoti nebereikia".
   */
  acceptedCommit: boolean;
  /** Task'ai, kuriuos šis run'as jau užvertė (snapshot'as arba einamoji būsena). */
  completedTaskIds?: Iterable<string>;
};

export type ResumeAction =
  /** Nėra ką atkurti. */
  | "no-checkpoint"
  /** Darbas jau priimtas arba lifecycle užvertas — task'as NEVYKDOMAS iš naujo. */
  | "skip-completed"
  /** Nebaigtas attempt'as resumable bucket'e — perduodama esamam resume keliui. */
  | "resume-attempt"
  /** Task'as saugiai pakartojamas: jis grįžo į eilę, priimto darbo nėra. */
  | "retry-task"
  /** Checkpoint'as rodo į kitą grafą — ignoruojamas, planas skaičiuojamas iš naujo. */
  | "discard-stale"
  /** Attempt'as prasidėjo, task'o failo nebėra, priimto darbo taip pat — reikia žmogaus. */
  | "escalate-human";

export type ResumeReasonCode =
  | "missing-checkpoint"
  | "missing-task-id"
  | "already-completed"
  | "accepted-commit"
  | "graph-hash-mismatch"
  | "terminal-bucket"
  | "checkpoint-finished"
  | "interrupted-attempt"
  | "requeued-task"
  | "task-file-absent";

export type ResumeDecision = {
  action: ResumeAction;
  task_id?: string;
  reason: string;
  reason_codes: ResumeReasonCode[];
  /** `true` tik tada, kai task'ą galima paleisti iš naujo nedubliuojant priimto darbo. */
  replay_safe: boolean;
};

function decision(
  action: ResumeAction,
  reasonCodes: ResumeReasonCode[],
  replaySafe: boolean,
  taskId?: string,
): ResumeDecision {
  return {
    action,
    ...(taskId === undefined ? {} : { task_id: taskId }),
    reason: `rr${RESUME_RULES_VERSION}:${action} ${reasonCodes.join(",")}`,
    reason_codes: reasonCodes,
    replay_safe: replaySafe,
  };
}

/**
 * Ar checkpoint'o task'as YRA užbaigtų sąraše. Tapatybė, tad tikslus palyginimas.
 *
 * Anksčiau čia dirbo simetriškas priklausomybių prefiksų matcher'is, ir checkpoint'as
 * `0042-parent-02-child` prieš užbaigtų sąrašą `[0042-parent]` gaudavo
 * `skip-completed / already-completed` — o atkūrimo kelias toliau galėjo perkelti vaiko failą į
 * `done` jo NEVYKDĘS. Prefiksas atsako į klausimą „kurį task'ą reiškia ši nuoroda"; čia
 * klausimas kitas — „ar tai tas pats task'as", ir jis prefiksų neturi.
 */
function isCompleted(taskId: string, candidates: Iterable<string>): boolean {
  for (const candidate of candidates) {
    if (isSameTask(taskId, candidate)) return true;
  }
  return false;
}

/**
 * Vienintelė vieta, kur gimsta resume sprendimas. Taisyklės taikomos griežta tvarka, o
 * tvarka yra pati taisyklė:
 *
 *  1. Nėra checkpoint'o arba task ID — nėra ko atkurti.
 *  2. Task'as jau užvertas šiame run'e — praleidžiamas (apsauga nuo dvigubo vykdymo).
 *  3. PRIIMTAS COMMIT nustelbia viską, įskaitant stale grafą (WAVE-2).
 *  4. Grafo hash'o nesutapimas — checkpoint'as priklauso kitam planui; atmetamas, ne
 *     interpretuojamas prieš dabartinį grafą.
 *  5. Toliau sprendžia task'o VIETA: terminal = užversta; resumable = tęsiam attempt'ą;
 *     queue = saugus pakartojimas; nėra failo = neaiški būsena žmogui.
 *
 * Idempotentiškumas: tie patys įėjimai visada duoda tą patį sprendimą, o „skip-completed"
 * ir „escalate-human" šakos NIEKADA negrąžina `replay_safe: true`.
 */
export function decideResume(
  checkpoint: ResumeCheckpointView | undefined,
  evidence: ResumeEvidence,
): ResumeDecision {
  if (!checkpoint) return decision("no-checkpoint", ["missing-checkpoint"], false);

  const taskId = normalizeTaskReference(checkpoint.task_id ?? "");
  if (!taskId) return decision("no-checkpoint", ["missing-task-id"], false);

  if (isCompleted(taskId, evidence.completedTaskIds ?? [])) {
    return decision("skip-completed", ["already-completed"], false, taskId);
  }

  if (evidence.acceptedCommit) {
    return decision("skip-completed", ["accepted-commit"], false, taskId);
  }

  if (checkpoint.graph_hash && evidence.currentGraphHash && checkpoint.graph_hash !== evidence.currentGraphHash) {
    return decision("discard-stale", ["graph-hash-mismatch"], false, taskId);
  }

  if (evidence.location === "terminal-bucket") {
    return decision("skip-completed", ["terminal-bucket"], false, taskId);
  }

  if (evidence.location === "absent") {
    // „finished"/„moved" + failo nebėra = normali pabaiga (task'as perkeltas į done):
    // atkurti nėra ko. Bet „started"/„waiting"/„failed" + nei failo, nei commit'o —
    // būsena neatsekama, ir spėlioti čia būtų blogiau nei eskaluoti.
    const finished = checkpoint.status === "finished" || checkpoint.status === "moved";
    return finished
      ? decision("skip-completed", ["checkpoint-finished"], false, taskId)
      : decision("escalate-human", ["task-file-absent"], false, taskId);
  }

  if (evidence.location === "queue") {
    return decision("retry-task", ["requeued-task"], true, taskId);
  }

  return decision("resume-attempt", ["interrupted-attempt"], true, taskId);
}

/**
 * Log priedas atvejui, kai `discard-stale` palieka task'o failą resumable bucket'e
 * (active/delegated/error): checkpoint'as priklauso kitam grafui, o naujas planas task'us mato
 * TIK per eilę — be perkėlimo failas lieka strandintas amžiams ir daugiau negeneruoja jokio
 * įvykio (GeoGravity 1178-a-02, 2026-08-29: po graph-hash-mismatch failas liko `active/` ir
 * eilė tyliai jį aplenkė). Kol requeue neautomatizuotas, operatorius bent gauna aiškų veiksmą
 * vietoj tylos. Kitoms baigtims grąžinama tuščia eilutė — log formatas nepakinta.
 */
export function describeStrandedStaleResume(decision: ResumeDecision, location: ResumeTaskLocation): string {
  if (decision.action !== "discard-stale" || location !== "resumable-bucket") return "";
  return " — STALE TASK STRANDED: task file is not part of the new plan; move it back to queue (requeue) to dispatch again";
}

// `resumeAllowsDispatch` gyveno čia iki 2026-08-23: doc'as teigė „naudojama loop'e kaip
// vienas vartas", bet nė vieno produkcinio kvietėjo neturėjo NEI čia, NEI etalone — tik
// testus. Tikroji apsauga nuo pakartotinio dispatch'o yra BŪSENA: `recoverFromCrash`
// skip-completed atveju task'ą deda į `started`/`completed`, o `selectNextWaveTask`
// startavusių nebeima. Vartas, aprašytas kaip vienintelis ir nepasiekiamas iš niekur,
// yra blogiau nei jo nebuvimas (ta pati pamoka kaip `assertExecutableTaskGraph`).
