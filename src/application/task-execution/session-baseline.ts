// Sesijos baseline ir gyvo dispatch bandymo GRYNOSIOS taisyklės (etalonas: AG_loop
// hooks/session-staging.ts baseline blokas — task 0016/0056). IO pusė (rašymas SessionStart
// metu, skaitymas Stop hook'e) — interfaces/hooks adapteriai.
//
// `task-start-status.json` fiksuoja UŽDUOTIES aktyvaciją, o tarp jos ir sesijos starto
// co-tenant'as spėja pridirbti: clean-baseline rescue tada išgelbėdavo svetimus purvinus failus
// į šio task'o commit'ą. Sesijos baseline atsako į tikslesnį klausimą — ar medis buvo švarus,
// kai ŠI sesija pradėjo dirbti.

import path from "node:path";
import { normalizeGitPath, type DirtyEntry } from "../../domain/git/changes.js";

export type SessionStartBaseline = {
  dispatch_nonce?: string;
  task_id?: string;
  baseline_valid?: boolean;
  non_runtime_dirty_entries?: DirtyEntry[];
  updated_at?: string;
};

export function sessionStartStatusPath(stateDir: string): string {
  return path.join(stateDir, "session-start-status.json");
}

/**
 * `true`, kai baseline priklauso ŠIAI sesijai IR jos starte medyje nebuvo NEPAAIŠKINTO purvo.
 * Svetimas arba pasenęs baseline (kito nonce) nesako nieko, tad grąžina `false` ir kvietėjas
 * krenta į ankstesnę, task lygio taisyklę.
 *
 * `explainedPaths` yra to paties task'o jau žinomi rašymai (ledger'is, filtruotas pagal
 * nuosavybę). Be jų retry/repair sesija visada matytų purviną medį — pirmojo bandymo
 * necommit'intą darbą — ir TYLIAI išjungtų ledger-miss rescue ten, kur jis anksčiau veikė.
 * Su jais lieka tik tikras klausimas: ar starto metu medyje buvo purvo, kurio šis task'as
 * nepadarė.
 */
export function sessionBaselineWasClean(
  baseline: SessionStartBaseline,
  dispatchNonce: string,
  explainedPaths: ReadonlySet<string> = new Set(),
): boolean {
  if (!dispatchNonce || baseline.dispatch_nonce !== dispatchNonce) return false;
  if (baseline.baseline_valid !== true) return false;
  return (baseline.non_runtime_dirty_entries ?? []).every((entry) =>
    explainedPaths.has(normalizeGitPath(entry.path)),
  );
}

/** Ar šiai sesijai apskritai yra užrašytas baseline (t. y. ar juo galima pakeisti task taisyklę). */
export function sessionBaselineBelongsToSession(baseline: SessionStartBaseline, dispatchNonce: string): boolean {
  return Boolean(dispatchNonce) && baseline.dispatch_nonce === dispatchNonce;
}

/**
 * Ar SessionStart firing'as priklauso TAM PAČIAM dispatch bandymui, kurio baseline jau
 * užrašytas?
 *
 * Payload'o šaltinis (`compact`/`resume`) atpažįsta tik tai, ką praneša pats payload'as, bet tas
 * pats bandymas gali paleisti SessionStart ir su `startup` šaltiniu (CLI restartas su tuo pačiu
 * nonce). Tada `startup` šaka vidury gyvo bandymo perrašydavo baseline JAU PURVINU medžiu ir
 * nušluodavo readme įrodymą, kurio agentas atkurti nebegali.
 *
 * Tapatybė yra TIK dispatch nonce: jis atsitiktinis kiekvienam dispatch'ui, tad baseline su MŪSŲ
 * nonce galėjo užrašyti tik ši pati sesija. `current-task-id` į sąlygą sąmoningai NEĮTRAUKTAS —
 * tas failas globalus ir last-writer-wins, tad co-tenant'o aktyvuotas kitas task'as būtų
 * apvertęs sąlygą į „naujas bandymas" būtent tada, kai vartai reikalingiausi.
 */
export function sessionStartIsSameAttempt(baseline: SessionStartBaseline, dispatchNonce: string): boolean {
  return sessionBaselineBelongsToSession(baseline, dispatchNonce.trim());
}

/**
 * Kiek laiko dispatch checkpoint'o „started" įrašas dar laikomas GYVU dispatch'u.
 *
 * Riba trumpa sąmoningai: ji yra vienintelis dalykas, skiriantis „dispatch tebedirba" nuo
 * „orkestratorius nužudytas ir checkpoint'as liko gulėti". Per ilga riba paliktų interaktyvias
 * sesijas amžinai su pasenusia readme evidencija; per trumpa grąžintų klaidą, kurią vartai
 * ir turi uždaryti. 90 min = numatytas dispatch wall-clock langas plius atsarga.
 */
export const LIVE_DISPATCH_MAX_AGE_MS = 90 * 60 * 1000;

/**
 * Minimalus resume checkpoint'o pjūvis, kurio reikia gyvumo sprendimui.
 *
 * `| undefined` eksplicitiškai (ta pati priežastis kaip `AgentRoleConfig`): tikrasis tiekėjas yra
 * zod schema, o `.optional()` inferuoja būtent `T | undefined`. Su `exactOptionalPropertyTypes`
 * siauresnė forma atmestų realų `readResumeCheckpoint` rezultatą, ir vaizdas, sukurtas tam, kad
 * saugykla būtų PAKEIČIAMA, priimtų tik fiktyvią.
 */
export type DispatchCheckpointView = {
  phase?: string | undefined;
  status?: string | undefined;
  task_id?: string | undefined;
  updated_at?: string | undefined;
};

/**
 * Ar šiuo metu vyksta dispatch'as, kurio įrodymų interaktyvi sesija liesti negali?
 *
 * Signalas yra BŪSENOS PERĖJIMAS, ne mtime euristika: dispatch'as rašo `started` prieš
 * paleisdamas Claude ir `finished`/`failed` po jo grįžimo (taip pat po timeout kill'o), tad
 * signalas išsivalo pats. `current-task-id` niekada nevalomas, o paskutinio exit kodo failas
 * lieka gulėti amžinai — todėl nė vienas iš jų netinka.
 */
export function dispatchAttemptIsLive(
  checkpoint: DispatchCheckpointView | undefined,
  currentTaskId: string,
  nowMs: number = Date.now(),
): boolean {
  if (!checkpoint) return false;
  if (checkpoint.phase !== "dispatch" || checkpoint.status !== "started") return false;
  const taskId = (checkpoint.task_id ?? "").trim();
  if (!taskId || taskId !== currentTaskId.trim()) return false;
  const updatedAt = Date.parse(checkpoint.updated_at ?? "");
  if (!Number.isFinite(updatedAt)) return false;
  const ageMs = nowMs - updatedAt;
  // Apatinis rėžis yra saugumo sąlyga, ne kosmetika: į ATEITĮ datuotas `updated_at` (atsuktas
  // laikrodis, VM snapshot, NTP korekcija, checkpoint'as iš kito konteinerio) duotų neigiamą
  // amžių, kuris viršutinę ribą tenkina VISADA — vartai tada liktų atviri neribotai ir
  // interaktyvios sesijos paveldėtų svetimą readme įrodymą be jokio savo skaitymo.
  return ageMs >= 0 && ageMs <= LIVE_DISPATCH_MAX_AGE_MS;
}
