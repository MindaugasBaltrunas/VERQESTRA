// Worker pool leidimo vartai: „ar ŠĮ kandidatą apskritai galima leisti į slot'ą" (spec
// PAR-1/PAR-2/WRK-3, design §13). Behaviour etalon: AG_loop application/scheduling/
// worker-pool.ts leidimo pusė (etalono 783 eil. failas skaidomas į admission + plan pagal
// 500 eil. gate; visi vardai ir taisyklės 1:1).
//
// `conflict-detector.ts` atsako „ar šie du task'ai nepriklausomi". Šis modulis — platesnį:
// nepriklausomumas yra tik viena sąlyga; be jo dar privalo galioti runtime izoliacija —
// atskiras lease, atskira darbo kopija ir atskiras run/worker/task/attempt namespace.
//
// Izoliacija yra KONSTRUKCIJOS savybė, ne runtime įrodymas (operatoriaus mandatas
// 2026-08-11): slot'o leidimas yra write-set nesikirtimas + galiojantis lease + atskira
// darbo kopija. Nieko daugiau. Kiekvienas atmetimas turi vardą.
//
// Modulis grynas: „dabar" ir worktree keliai ateina kaip įvestis.

import { createHash } from "node:crypto";
import { isLeaseActive, type WorkerLease } from "../../domain/scheduling/index.js";
import { canonicalJsonStringify } from "../../shared/json.js";
import {
  evaluateWriteSetIndependence,
  type IndependenceVerdict,
  type TaskWriteSet,
} from "./conflict-detector.js";
import { formatAttemptId, formatWorkerId, type AttemptRef } from "./worker-limits.js";

export const WORKER_POOL_VERSION = 1;

export type WorkerCandidate = {
  task_id: string;
  /** Repo-relative task failo kelias — dispatch'o adresas. */
  file: string;
  /** Ready set gylis; pirmas deterministinės tvarkos raktas. */
  depth?: number;
  /** 1-based bandymo numeris; naudojamas attempt namespace. */
  attempt?: number;
  write_set: TaskWriteSet;
  /** Šio task'o lease. Antram workeriui jis privalomas ir privalo būti aktyvus. */
  lease?: WorkerLease;
  /** Repo-relative izoliuotos darbo kopijos kelias (POSIX). Antram workeriui privalomas. */
  worktree_path?: string;
};

export type ParallelRejectionReason =
  /** Kandidatų yra, bet limitas jau užpildytas. */
  | "hard-cap"
  /** Bangoje yra tik vienas kandidatas. */
  | "single-candidate"
  /** Paralelizmo niekas neprašė (`requested_workers < 2`). */
  | "sequential-requested"
  /** Write set'ai kertasi. */
  | "write-set-conflict"
  /** Neapibrėžtas arba wildcard scope, arba nepatikrintas kontraktas (spec PAR-2). */
  | "unknown-scope"
  /** Lease nepateiktas. */
  | "missing-lease"
  /** Lease pateiktas, bet nebegalioja (atlaisvintas arba pasibaigęs). */
  | "inactive-lease"
  /** Lease priklauso kitam task'ui. */
  | "lease-task-mismatch"
  /** Izoliuota darbo kopija nenurodyta. */
  | "missing-worktree"
  /** Abu kandidatai rodo į tą pačią (arba įdėtą) darbo kopiją. */
  | "shared-worktree"
  /** Operatoriaus valdiklis laiko BŪTENT šį slot'ą (`drain`/`abort`) — kiti slot'ai nepaliesti. */
  | "slot-drained"
  /** Viso loop'o stop vėliava — papildymo negauna nė vienas slot'as; vykdomi attempt'ai nekertami. */
  | "stop-requested"
  /** Ready set'e nebeliko nė vieno vertintino kandidato. */
  | "no-candidate";

export type WorkerRejection = {
  task_id: string;
  reason: ParallelRejectionReason;
  detail: string;
};

export type WorkerSlot = {
  /** 1-based indeksas; `1` yra pirminis slot'as, kuris egzistuoja visada. */
  worker_index: number;
  worker_id: string;
  task_id: string;
  file: string;
  attempt: number;
  /** Atskiras `run/worker/task/attempt` namespace: context, usage, log ir stop state neturi bendrų failų. */
  attempt_ref: AttemptRef;
  lease_id?: string;
  worktree_path?: string;
};

// NE `shared/paths.toComparablePosixPath` (etalono task 0064 pastaba): galiniai `/` kerpami
// PRIEŠ `trim`, tad `"a/  "` čia duoda `"a/"`, o bendras helper'is duotų `"a"` — write
// scope prefiksų lyginimas.
function toPosix(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
}

function attemptOf(candidate: WorkerCandidate): number {
  const attempt = candidate.attempt ?? 1;
  return Number.isInteger(attempt) && attempt >= 1 ? attempt : 1;
}

/**
 * Deterministinė kandidatų tvarka: gylis ↑, tada `task_id` ↑, su dedublikacija pagal
 * `task_id`. Tvarkos taisyklė privalo būti VIENA: bangos planas ir atsilaisvinusio slot'o
 * papildymas negali rinktis kandidatų skirtinga tvarka — kitaip tas pats ready set duotų
 * skirtingus laimėtojus priklausomai nuo to, kuris kelias jį įvertino.
 */
export function orderWorkerCandidates(candidates: readonly WorkerCandidate[]): WorkerCandidate[] {
  const byTask = new Map<string, WorkerCandidate>();
  // Seklesni mazgai pirma (jie atblokuoja daugiau), tada task ID — ta pati tvarka kaip
  // `build-ready-set.ts`, todėl slot'ų priskyrimas po restart'o atkuriamas identiškai.
  const ordered = [...candidates].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.task_id.localeCompare(b.task_id));
  for (const candidate of ordered) {
    if (!byTask.has(candidate.task_id)) byTask.set(candidate.task_id, candidate);
  }
  return [...byTask.values()];
}

/**
 * `WorkerSlot` konstrukcija su atskiru `run/worker/task/attempt` namespace'u. Papildomas
 * slot'as gauna TĄ PAČIĄ struktūrą kaip bangos plano slot'as, tad antro konstravimo kelio
 * (ir antros attempt namespace taisyklės) neatsiranda.
 */
export function buildWorkerSlot(runId: string, workerIndex: number, candidate: WorkerCandidate): WorkerSlot {
  const attempt = attemptOf(candidate);
  const workerId = formatWorkerId(workerIndex);
  const slot: WorkerSlot = {
    worker_index: workerIndex,
    worker_id: workerId,
    task_id: candidate.task_id,
    file: candidate.file,
    attempt,
    attempt_ref: {
      runId,
      workerId,
      taskId: candidate.task_id,
      attemptId: formatAttemptId(attempt),
    },
  };
  if (candidate.lease) slot.lease_id = candidate.lease.lease_id;
  if (candidate.worktree_path) slot.worktree_path = toPosix(candidate.worktree_path);
  return slot;
}

/** Papildomas kontekstas eligibility patikrai (primary-tree bootstrap). */
export type SlotEligibilityOptions = {
  /**
   * Kai `true`, kandidato trūkstamas `lease`/`worktree_path` NĖRA blokuojanti klaida — jis
   * traktuojamas kaip pirminis slot'as, dirbantis pirminiame medyje pagal dizainą. Kitos
   * realios eligibility klaidos (neapibrėžtas write-set, lease priklauso kitam task'ui,
   * lease neaktyvus) tebeblokuoja nepaisant šios vėliavos.
   */
  allowPrimaryTreeState?: boolean;
};

/**
 * Runtime izoliacijos vartai vienam kandidatui: lease privalo egzistuoti, galioti ir
 * priklausyti BŪTENT šiam task'ui, o darbo kopija — būti nurodyta. Grąžinama pirma
 * nepatenkinta sąlyga. `allowPrimaryTreeState` sušvelnina TIK „lease/worktree nenurodyti":
 * lease egzistuojantis, bet sugadintas, tebėra reali klaida.
 */
function checkIsolation(candidate: WorkerCandidate, now: Date, options?: SlotEligibilityOptions): WorkerRejection | undefined {
  if (!candidate.lease) {
    if (options?.allowPrimaryTreeState) return undefined;
    return { task_id: candidate.task_id, reason: "missing-lease", detail: "antram workeriui reikalingas worker lease" };
  }
  if (!isLeaseActive(candidate.lease, now)) {
    return {
      task_id: candidate.task_id,
      reason: "inactive-lease",
      detail: `lease ${candidate.lease.lease_id} yra '${candidate.lease.status}' ir galioja iki ${candidate.lease.expires_at}`,
    };
  }
  if (candidate.lease.task_id !== candidate.task_id) {
    return {
      task_id: candidate.task_id,
      reason: "lease-task-mismatch",
      detail: `lease ${candidate.lease.lease_id} yra task'ui ${candidate.lease.task_id}`,
    };
  }
  if (!candidate.worktree_path || !toPosix(candidate.worktree_path)) {
    if (options?.allowPrimaryTreeState) return undefined;
    return {
      task_id: candidate.task_id,
      reason: "missing-worktree",
      detail: "antram workeriui reikalinga izoliuota darbo kopija",
    };
  }
  return undefined;
}

/**
 * Slot'o kandidato PATIES įrodymai: apibrėžtas write scope + runtime izoliacija. Ta pati
 * funkcija taikoma ir jau užimtam slot'ui — „ar šis kandidatas apskritai tinka slot'ui"
 * turi VIENĄ apibrėžimą bangos planui ir atsilaisvinusio slot'o papildymui.
 */
export function checkSlotEligibility(
  candidate: WorkerCandidate,
  now: Date,
  options?: SlotEligibilityOptions,
): WorkerRejection | undefined {
  if (!candidate.write_set.determinate) {
    return {
      task_id: candidate.task_id,
      reason: "unknown-scope",
      detail: candidate.write_set.gaps.map((gap) => `${gap.code}: ${gap.detail}`).join("; "),
    };
  }
  return checkIsolation(candidate, now, options);
}

export type WorkerAdmission = {
  admitted: boolean;
  rejection?: WorkerRejection;
  /** Įvertinti nepriklausomumo verdiktai — po vieną kiekvienam realiai palygintam užimtajam. */
  verdicts: IndependenceVerdict[];
};

export type CandidateWriteSetVerdict = {
  verdict: IndependenceVerdict;
  /** Užpildytas TIK kai sankirta blokuoja. Atmetimas visada kabinamas prie KANDIDATO task'o. */
  rejection?: WorkerRejection;
};

/**
 * Vienos poros (užimtasis × kandidatas) write-set sankirta ir jos atmetimo įrašas.
 *
 * „Ar šiuos du galima leisti kartu" turi VIENĄ apibrėžimą: leidimo vartas ir provisioning'o
 * pre-check privalo matuoti tą pačią sankirtą ta pačia priežastimi — kitaip provisioning'as
 * išduoda lease kandidatui, kurį vartas iškart atmeta.
 */
export function evaluateCandidateWriteSet(
  occupant: WorkerCandidate,
  candidate: WorkerCandidate,
): CandidateWriteSetVerdict {
  const verdict = evaluateWriteSetIndependence(occupant.write_set, candidate.write_set);
  if (verdict.independent) return { verdict };
  return {
    verdict,
    rejection: {
      task_id: candidate.task_id,
      reason: verdict.conflicts.length > 0 ? "write-set-conflict" : "unknown-scope",
      detail: verdict.reason,
    },
  };
}

/**
 * Pirmas užimtasis, su kuriuo kandidato write set'as kertasi (arba `undefined`).
 *
 * Skirtingai nuo `admitWorkerCandidate`, ši patikra NEreikalauja kandidato izoliacijos
 * įrodymų (lease, darbo kopija): ji atsako būtent į tą klausimą, kurį reikia užduoti PRIEŠ
 * juos išduodant. Pats kandidatas užimtųjų sąraše praleidžiamas — task'as niekada
 * nekonfliktuoja su savimi.
 */
export function findWriteSetConflict(
  candidate: WorkerCandidate,
  occupants: readonly WorkerCandidate[],
): { occupant: WorkerCandidate; rejection: WorkerRejection } | undefined {
  for (const occupant of occupants) {
    if (occupant.task_id === candidate.task_id) continue;
    const { rejection } = evaluateCandidateWriteSet(occupant, candidate);
    if (rejection) return { occupant, rejection };
  }
  return undefined;
}

/**
 * VIENINTELIS leidimo vartas vienam kandidatui prieš N jau užimtų slot'ų.
 *
 * Tvarka fiksuota: (1) kandidato savi įrodymai, (2) kiekvienam `occupants` nariui iš
 * eilės — užimtojo savi įrodymai, darbo kopijų atskirumas, write-set nepriklausomumas.
 * `N = 1` duoda tą patį rezultatą kaip bangos plano ciklas; `N > 1` yra ta pati taisyklė,
 * pritaikyta GRIEŽČIAU — kandidatas privalo būti nepriklausomas nuo VISŲ dirbančių slot'ų.
 */
export function admitWorkerCandidate(input: {
  candidate: WorkerCandidate;
  occupants: readonly WorkerCandidate[];
  now: Date;
  /**
   * Kai `true`, `occupants` narių trūkstamas lease/worktree netrukdo: naudojama TIK
   * pirminiam slot'ui primary-tree režime, niekada paties `candidate` patikrai — antras
   * kandidatas privalo turėti pilnus įrodymus visada.
   */
  allowOccupantPrimaryTreeState?: boolean;
}): WorkerAdmission {
  const verdicts: IndependenceVerdict[] = [];

  const own = checkSlotEligibility(input.candidate, input.now);
  if (own) return { admitted: false, rejection: own, verdicts };

  // `checkSlotEligibility` jau įrodė, kad kelias yra; toliau jis naudojamas kaip reikšmė.
  const candidateWorktree = toPosix(input.candidate.worktree_path ?? "");

  for (const occupant of input.occupants) {
    // Užimtojo įrodymai tikrinami iš naujo, o ne laikomi galiojančiais nuo jo paleidimo:
    // pasibaigęs lease reiškia, kad jo izoliacija nebeįrodyta, tad prie jo nieko
    // prigretinti negalima. Atmetimas kabinamas prie UŽIMTOJO task'o.
    const occupied = checkSlotEligibility(occupant, input.now, {
      ...(input.allowOccupantPrimaryTreeState === undefined
        ? {}
        : { allowPrimaryTreeState: input.allowOccupantPrimaryTreeState }),
    });
    if (occupied) return { admitted: false, rejection: occupied, verdicts };

    // Primary-tree occupant'as neturi jokios izoliuotos darbo kopijos apskritai — jis
    // dirba pačiame projekto medyje, ne tuščiame kelyje, kurį `worktreePathsAreDisjoint`
    // be šios išimties suprastų kaip „nenurodyta, tad kolizija".
    const occupantIsPrimaryTreeState = Boolean(input.allowOccupantPrimaryTreeState) && !occupant.worktree_path;
    const occupantWorktree = toPosix(occupant.worktree_path ?? "");
    if (!occupantIsPrimaryTreeState && !worktreePathsAreDisjoint(occupantWorktree, candidateWorktree)) {
      return {
        admitted: false,
        rejection: {
          task_id: input.candidate.task_id,
          reason: "shared-worktree",
          detail: `darbo kopija '${candidateWorktree}' nėra atskira nuo '${occupantWorktree}'`,
        },
        verdicts,
      };
    }

    const { verdict, rejection } = evaluateCandidateWriteSet(occupant, input.candidate);
    verdicts.push(verdict);
    if (rejection) return { admitted: false, rejection, verdicts };
  }

  return { admitted: true, verdicts };
}

/**
 * Ar dvi darbo kopijos tikrai atskiros. Įdėta kopija (`a` viduje `b`) yra ta pati klaida
 * kaip sutampantis kelias: vienas workeris rašytų į kito medį.
 */
export function worktreePathsAreDisjoint(left: string, right: string): boolean {
  const a = toPosix(left).toLowerCase();
  const b = toPosix(right).toLowerCase();
  if (!a || !b) return false;
  return a !== b && !a.startsWith(`${b}/`) && !b.startsWith(`${a}/`);
}

/**
 * Bendra planavimo sprendimų atspaudo erdvė: `<prefix>:<sha256 pirmi 16 hex>` iš kanoninio
 * JSON. Prefiksas yra dalis kontrakto — jis pasako, KURIOS taisyklės pagimdė atspaudą
 * (`wp1` — bangos pool'as, `sr1` — slot'o papildymas), tad dvi skirtingos sprendimų erdvės
 * niekada nesumaišomos viename lauke.
 */
export function computeSchedulingHash(prefix: string, payload: unknown): string {
  const digest = createHash("sha256").update(canonicalJsonStringify(payload), "utf8").digest("hex");
  return `${prefix}:${digest.slice(0, 16)}`;
}
