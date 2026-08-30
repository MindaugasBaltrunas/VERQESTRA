// Session-write nuosavybės GRYNOS taisyklės (etalonas: AG_loop hooks/session-staging.ts
// ownership pusė — task 0018/0056). Sidecar'as, o ne naujas laukas session-writes.json:
// to failo on-disk kontraktas (JSON string masyvas) turi 6+ skaitytojų, tad formos keitimas
// būtų lūžis jiems visiems. IO pusė (recordSessionWriteOwner po ledger lock'u,
// clearSessionWriteLedger) — VQ-502 hooks adapteriai; čia tik kelio taisyklė ir filtras,
// kurį jau dabar vartoja diagnozės adapteris.

import path from "node:path";
import { normalizeGitPath, sessionScopedChangedFiles } from "../../domain/git/changes.js";

export type SessionWriteOwner = {
  /** Dispatch sesijų nonce'ai, rašę šį kelią. Interaktyvios sesijos čia nieko nededa. */
  sessions: string[];
  /** Užduotys, kurių dispatch'as rašė kelią. */
  tasks: string[];
};

export type SessionWriteOwners = Record<string, SessionWriteOwner>;

/** Sidecar failo kelias šalia session-writes.json (etalono taisyklė 1:1). */
export function sessionWriteOwnersPath(sessionWritesPath: string): string {
  return path.join(path.dirname(sessionWritesPath), "session-write-owners.json");
}

/** Kas rašo: dispatch nonce (arba `session:<claude session_id>`) ir užduotis, jei ji yra. */
export type SessionWriteIdentity = { session: string; taskId: string };

/**
 * Įpina tapatybę į savininkų sidecar'ą. Grąžina naują įrašą su jo raktu arba `undefined`, kai
 * rašyti nėra ko — kvietėjas iš to sprendžia, ar apskritai liesti failą (rašymas vyksta po
 * ledger'io lock'u, tad kiekvienas nereikalingas įrašas kainuoja kritinės sekcijos laiką).
 *
 * Aibės, o ne vienas savininkas: tą patį failą per užduotį rašo dispatch sesija, repair sesija
 * ir kartais interaktyvi — pirmas-laimi būtų tyliai atėmęs nuosavybę iš vėlesnio rašytojo ir jo
 * darbas liktų necommit'intas.
 *
 * Tuščia sesija NIEKADA nerašoma: kelias be savininko įrašo reiškia „legacy / nežinoma", o toks
 * kelias {@link filterStagePathsByOwnership} lieka stage'inamas. Tuščio savininko įrašymas tą
 * saugią „nežinau" būseną paverstų melagingu „žinau, ir tai ne tu".
 */
export function mergeSessionWriteOwner(
  owners: SessionWriteOwners,
  entry: string,
  identity: SessionWriteIdentity,
): { key: string; owner: SessionWriteOwner } | undefined {
  const session = identity.session.trim();
  const taskId = identity.taskId.trim();
  if (!session) return undefined;

  const key = normalizeGitPath(entry);
  const current = owners[key];
  const sessions = new Set(current?.sessions ?? []);
  const tasks = new Set(current?.tasks ?? []);
  const before = sessions.size + tasks.size;
  sessions.add(session);
  if (taskId) tasks.add(taskId);
  if (current && sessions.size + tasks.size === before) return undefined;

  return { key, owner: { sessions: [...sessions], tasks: [...tasks] } };
}

/**
 * Ar task'o aktyvacija turi teisę išvalyti session-writes ledger'į (etalono task 1100 1:1).
 *
 * Tik NAUJAS task'as valo: to paties task'o retry / repair / resume ciklas privalo matyti ir
 * ankstesnių bandymų produkto rašymus — besąlyginis valymas ištrindavo pirmo bandymo rašymus,
 * ir finalinis Stop hook'as jų nebestage'indavo.
 */
export function shouldResetSessionWriteLedger(previousTaskId: string | undefined, taskId: string): boolean {
  return !previousTaskId || previousTaskId !== taskId;
}

export type StageOwnershipResult = {
  /** Keliai, kuriuos ši sesija turi teisę stage'inti / priskirti sau. */
  paths: string[];
  /** Keliai, kurie ĮRODYTAI priklauso svetimai sesijai ir buvo palikti nepaliesti. */
  foreign: string[];
};

/**
 * Išmeta tuos ledger'io kelius, kurie ĮRODYTAI priklauso svetimai sesijai.
 *
 * Taisyklė sąmoningai asimetriška — metama tik kai svetimumas ĮRODOMAS: žinome savo
 * tapatybę (`identity.session` netuščias), kelias TURI savininko įrašą su bent viena
 * sesija, mūsų sesijos tarp jų nėra IR nė viena savininko užduotis nesutampa su mūsų
 * (to paties task'o dispatch + repair ciklas yra vienas darbo vienetas — per-TASK
 * ledger'is). Visais kitais atvejais (nėra įrašo, tuščios sesijos, legacy failas be
 * sidecar'o) kelias lieka — tai griežtai SIAURINA, o ne silpnina apsaugą.
 */
export function filterStagePathsByOwnership(
  paths: readonly string[],
  owners: SessionWriteOwners,
  identity: { session: string; taskId: string },
): StageOwnershipResult {
  const session = identity.session.trim();
  const taskId = identity.taskId.trim();
  if (!session) {
    return { paths: [...paths], foreign: [] };
  }

  const kept: string[] = [];
  const foreign: string[] = [];
  for (const candidate of paths) {
    const owner = owners[normalizeGitPath(candidate)];
    const ownerSessions = owner?.sessions ?? [];
    const ownerTasks = owner?.tasks ?? [];
    const provablyForeign =
      ownerSessions.length > 0 &&
      !ownerSessions.includes(session) &&
      !(taskId !== "" && ownerTasks.includes(taskId));
    if (provablyForeign) {
      foreign.push(candidate);
    } else {
      kept.push(candidate);
    }
  }
  return { paths: kept, foreign };
}

/** Kodėl rollback'as NEatstatė kelio, kurio savininkystės sidecar'as neįrodo. */
export type RestoreSkipReason =
  /** Sidecar'e nėra įrašo (legacy ledger'is, rašytas dar be savininkų failo). */
  | "no-ownership-record"
  /** Įrašas yra, bet jis tuščias — nei sesijos, nei užduoties. */
  | "empty-ownership-record"
  /** Nėra nei nonce, nei `current-task-id`: nėra su kuo lyginti savininkų įrašo. */
  | "unknown-current-task";

export type RestoreSkip = { path: string; reason: RestoreSkipReason };

export type TaskScopeRestorePlan = {
  /** Keliai, kuriuos rollback'as turi teisę atstatyti. */
  paths: string[];
  /** Keliai, ĮRODYTAI priklausantys svetimai sesijai ar užduočiai — paliekami nepaliesti. */
  foreign: string[];
  /** Keliai, kurių savininkystė nenustatoma — praleisti fail-closed, su priežastimi. */
  skipped: RestoreSkip[];
};

/**
 * Rollback'o atstatymo planas: kas nuosava, kas svetima ir kas praleista dėl neįrodomos
 * savininkystės.
 *
 * Rollback'as yra DESTRUKTYVUS ten, kur Stop staging'as tik pasyvus, tad taisyklė čia
 * apverčiama. {@link filterStagePathsByOwnership} be nonce sąmoningai nemeta nieko (jo
 * kontraktą dalijasi 3 kiti kvietėjai — Stop staging'as, package guard'as, diagnozė), bet tas
 * pats „nieko neįrodyta" rollback'e reiškia, kad į atstatymo aibę pakliūva VISAS bendras
 * ledger'is, įskaitant lygiagrečios sesijos necommit'intą darbą, ir jis revertinamas.
 *
 * Todėl be nonce sprendžia TIK savininkų sidecar'as, ne kvietėjo tapatybė: kelias atstatomas
 * vien tada, kai jo įrašas vardija šio task'o `current-task-id`. Įrašas, vardijantis ką nors
 * kita, yra `foreign`; įrašo nebuvimas, tuščias įrašas ar nežinomas einamasis task'as —
 * `skipped` su priežastimi (fail-closed: neatstatyti yra atstatoma klaida, atstatyti svetimą —
 * ne).
 *
 * Su nonce elgesys nesikeičia: ten tapatybė žinoma, ir tinka ta pati įrodyto svetimumo
 * taisyklė kaip staging'e.
 *
 * GRYNA sąmoningai: etalono `readFileSync` viduje yra jo silpnybė, ne kontraktas — IO lieka
 * adapteryje, kad rollback kelią būtų galima įrodyti be tikro repo.
 */
export function taskScopeRestorePlan(
  sessionWrites: readonly string[],
  owners: SessionWriteOwners,
  identity: SessionWriteIdentity,
): TaskScopeRestorePlan {
  // Runtime keliai nukrenta PIRMI: jie yra loop'o buhalterija, tad nei atstatomi, nei verti
  // eilutės ataskaitoje apie svetimą darbą.
  const candidates = sessionScopedChangedFiles(sessionWrites);
  const session = identity.session.trim();
  const taskId = identity.taskId.trim();

  if (session !== "") {
    const owned = filterStagePathsByOwnership(candidates, owners, { session, taskId });
    return { paths: owned.paths, foreign: owned.foreign, skipped: [] };
  }

  const paths: string[] = [];
  const foreign: string[] = [];
  const skipped: RestoreSkip[] = [];
  for (const candidate of candidates) {
    const owner = owners[normalizeGitPath(candidate)];
    const ownerSessions = owner?.sessions ?? [];
    const ownerTasks = owner?.tasks ?? [];
    if (taskId === "") {
      skipped.push({ path: candidate, reason: "unknown-current-task" });
    } else if (ownerTasks.includes(taskId)) {
      paths.push(candidate);
    } else if (ownerSessions.length > 0 || ownerTasks.length > 0) {
      foreign.push(candidate);
    } else {
      skipped.push({
        path: candidate,
        reason: owner === undefined ? "no-ownership-record" : "empty-ownership-record",
      });
    }
  }
  return { paths, foreign, skipped };
}

/**
 * Task'o NUOSAVI produkto keliai, kuriuos rollback'as gali atstatyti.
 *
 * Parašas laikomas siauras (`string[]`) dėl `infrastructure/git/rollback-scope.ts`
 * `taskScopePaths` porto — `foreign`/`skipped` prieinami per {@link taskScopeRestorePlan}.
 */
export function taskScopeRestorePaths(
  sessionWrites: readonly string[],
  owners: SessionWriteOwners,
  identity: SessionWriteIdentity,
): string[] {
  return taskScopeRestorePlan(sessionWrites, owners, identity).paths;
}
