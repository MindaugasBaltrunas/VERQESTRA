// VIENINTELIAI du eilės pakeitimai, kuriuos leidžiama daryti dashboard'ui (etalonas: AG_loop
// interfaces/http/ui-task-actions.ts, task 1207).
//
// Kryptys sąmoningai dvi ir tik dvi:
//
//   requeue   human-review -> queue   (tas pats perėjimas kaip CLI `requeue`)
//   complete  human-review -> done
//
// Viskas kita — task'as kitame bucket'e, task'o nėra, netinkama nuoroda — yra ATMETIMAS, o ne
// „artimiausias panašus veiksmas". Bucket'ų judinimas apskritai yra orkestratoriaus gyvavimo
// ciklas; šis modulis yra siaura triažo išimtis, todėl kiekvienas jo kelias baigiasi arba viena iš
// dviejų leistinų krypčių, arba klaida.

import path from "node:path";
import { taskBucketDir } from "../../application/task-execution/bucket-transition.js";
import type { TaskStateStorePort } from "../../application/task-execution/bucket-transition.js";
import { taskBuckets, type TaskBucket } from "../../domain/tasks/buckets.js";

/** Vienintelis leistinas šaltinio bucket'as. Bet koks kitas yra konfliktas, ne alternatyva. */
export const TASK_TRIAGE_SOURCE_BUCKET = "human-review" as const;

export type TaskTriageAction = "requeue" | "complete";

const TRIAGE_TARGETS: Record<TaskTriageAction, Extract<TaskBucket, "queue" | "done">> = {
  requeue: "queue",
  complete: "done",
};

export type TaskTriageResult = {
  action: TaskTriageAction;
  /** Task'o failo vardas, koks jis DABAR yra diske — jokių katalogų, jokių absoliučių kelių. */
  task: string;
  task_id: string;
  from: typeof TASK_TRIAGE_SOURCE_BUCKET;
  to: "queue" | "done";
  /** Ar ledger'yje buvo įrašas, kurį reikėjo išvalyti (requeue). */
  ledger_cleared: boolean;
  /** Ar LLM kvietimų biudžetas buvo atstatytas (requeue). */
  llm_budget_reset: boolean;
};

/** Nuoroda į task'ą nėra saugus failo vardas (separatoriai, `..`, tuščia, per ilga). */
export class InvalidTaskReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskReferenceError";
  }
}

/** Tokio task'o nėra NĖ VIENAME bucket'e. */
export class TaskNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskNotFoundError";
  }
}

/** Task'as egzistuoja, bet ne `human-review` — UI jo liesti negali. */
export class TaskBucketConflictError extends Error {
  constructor(
    readonly bucket: TaskBucket,
    message: string,
  ) {
    super(message);
    this.name = "TaskBucketConflictError";
  }
}

/** Nuosavybės vartai atmetė mutaciją (gyvas workerio lease). */
export class TaskAuthorityError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "TaskAuthorityError";
  }
}

const SAFE_TASK_STEM = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Nuoroda → failo vardas.
 *
 * Skirtingai nuo CLI, kuris iš kelio pasiima `basename`, HTTP įvestis su separatoriumi ar `..` čia
 * ATMETAMA, o ne apkarpoma: maršruto segmentas ateina iš tinklo, tad „beveik teisinga" nuoroda turi
 * baigtis klaida, o ne spėjimu, kurį failą vartotojas turėjo omenyje.
 */
export function taskFileName(reference: string): string {
  const trimmed = reference.trim();
  const stem = trimmed.toLowerCase().endsWith(".md") ? trimmed.slice(0, -".md".length) : trimmed;
  if (!stem || stem.length > 200 || !SAFE_TASK_STEM.test(stem)) {
    throw new InvalidTaskReferenceError(
      "task reference must be a plain task file name (letters, digits, '.', '_', '-')",
    );
  }
  return `${stem}.md`;
}

export type TaskTriagePorts = {
  /** Failų vardai bucket'e; nesamas katalogas — tuščias sąrašas. */
  listTaskFiles(absoluteDir: string): Promise<string[]>;
  /** Task'o id iš failo kelio — ta pati taisyklė kaip visame produkte. */
  taskIdFromFile(absoluteFile: string): string;
  /** Nuosavybės verdiktas PRIEŠ bet kokį rašymą; `ok: false` reiškia 409. */
  authorizeMutation(taskId: string): Promise<{ ok: boolean; reason?: string | undefined }>;
  /** `true`, kai ledger'yje buvo įrašas ir jis išvalytas. */
  clearLedgerEntry(taskId: string): Promise<boolean>;
  recordLlmCallReset(taskId: string): Promise<void>;
  store: TaskStateStorePort;
};

export type TaskTriageDeps = {
  ports: TaskTriagePorts;
  /** `<repo>/AG` — task bucket'ai lieka `AG/tasks/<bucket>`. */
  agRoot: string;
};

/**
 * Task'o failo vardas, KOKS JIS YRA DISKE.
 *
 * Windows failų sistema case-insensitive, tad failas rastųsi ir su kitokia raidžių lytimi — bet
 * task id bei tikslinis vardas būtų suskaičiuoti iš UŽKLAUSOS lyties. Tada ledger'io raktas
 * nesutaptų su tikruoju, o failas persivadintų perkėlimo metu. Todėl tapatybė visada imama iš
 * katalogo įrašo, o ne iš to, ką atsiuntė klientas.
 */
async function resolveBucketEntry(
  ports: TaskTriagePorts,
  agRoot: string,
  bucket: TaskBucket,
  taskName: string,
): Promise<string | undefined> {
  const files = await ports.listTaskFiles(taskBucketDir(agRoot, bucket));
  if (files.includes(taskName)) return taskName;
  const lowered = taskName.toLowerCase();
  return files.find((name) => name.toLowerCase() === lowered);
}

/** Kuriame bucket'e task'as guli. `undefined` = niekur. Naudojama TIK atmetimo priežasčiai. */
async function locateTaskBucket(
  ports: TaskTriagePorts,
  agRoot: string,
  taskName: string,
): Promise<TaskBucket | undefined> {
  for (const bucket of taskBuckets) {
    if (await resolveBucketEntry(ports, agRoot, bucket, taskName)) return bucket;
  }
  return undefined;
}

/**
 * Triažo veiksmas. Žingsnių tvarka requeue atveju yra TA PATI kaip CLI `requeue`:
 * ledger → LLM biudžeto atstatymas → perkėlimas.
 *
 * Prieš VISUS rašymus stovi nuosavybės vartai. Perkėlimas juos tikrina ir pats, bet tik perkėlimo
 * metu — t. y. gyvo workerio laikomas lease atmestų perkėlimą jau PO to, kai ledger'is išvalytas ir
 * biudžetas atstatytas. CLI tokį langą turi irgi, tačiau jį paleidžia žmogus rankomis; HTTP
 * paviršius tas lenktynes paverstų eiline situacija, o kontraktas reikalauja, kad konfliktas
 * nepaliktų JOKIOS būsenos mutacijos. Todėl verdiktas paimamas PIRMAS ir fail-closed.
 *
 * `updateCurrent: false` abiem kryptims: UI nėra loop'o procesas, o einamosios užduoties žymės
 * nukreipimas būtų svetimo gyvavimo ciklo perėmimas.
 */
export async function applyTaskTriage(
  deps: TaskTriageDeps,
  action: TaskTriageAction,
  reference: string,
): Promise<TaskTriageResult> {
  const ports = deps.ports;
  const requested = taskFileName(reference);
  const taskName = await resolveBucketEntry(ports, deps.agRoot, TASK_TRIAGE_SOURCE_BUCKET, requested);

  if (!taskName) {
    const bucket = await locateTaskBucket(ports, deps.agRoot, requested);
    if (bucket) {
      throw new TaskBucketConflictError(
        bucket,
        `task '${requested}' is in '${bucket}'; only '${TASK_TRIAGE_SOURCE_BUCKET}' tasks can be triaged from the UI`,
      );
    }
    throw new TaskNotFoundError(`task '${requested}' was not found in any task bucket`);
  }

  const to = TRIAGE_TARGETS[action];
  const source = path.join(taskBucketDir(deps.agRoot, TASK_TRIAGE_SOURCE_BUCKET), taskName);
  const taskId = ports.taskIdFromFile(source);

  const authority = await ports.authorizeMutation(taskId);
  if (!authority.ok) {
    throw new TaskAuthorityError(authority.reason ?? "unknown", `task '${taskId}' is owned by a live worker lease`);
  }

  let ledgerCleared = false;
  let llmBudgetReset = false;
  if (action === "requeue") {
    ledgerCleared = await ports.clearLedgerEntry(taskId);
    // Requeue yra aiškus žmogaus „bandyk dar kartą": ankstesnių (dažnai infrastruktūros nutrauktų)
    // ratų dispatch istorija nebeturi deginti kvietimų biudžeto.
    await ports.recordLlmCallReset(taskId);
    llmBudgetReset = true;
  }
  // `complete` yra žmogaus verdiktas „darbas priimtas". Ledger'io ir biudžeto įrašai NELIEČIAMI:
  // jie yra istorija apie tai, kas su task'u vyko, o užvertimas jos neatšaukia.

  const moved = await ports.store.moveTaskState(source, taskBucketDir(deps.agRoot, to), taskName, {
    updateCurrent: false,
  });

  return {
    action,
    // FAKTINIS vardas: kolizijos atveju perkėlimas prideda sufiksą, tad prašytasis vardas
    // tiksliniame bucket'e neegzistuotų ir atsakymas nurodytų failą, kurio nėra.
    task: path.basename(moved),
    task_id: taskId,
    from: TASK_TRIAGE_SOURCE_BUCKET,
    to,
    ledger_cleared: ledgerCleared,
    llm_budget_reset: llmBudgetReset,
  };
}
