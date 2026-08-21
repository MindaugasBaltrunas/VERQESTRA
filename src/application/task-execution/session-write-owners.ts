// Session-write nuosavybės GRYNOS taisyklės (etalonas: AG_loop hooks/session-staging.ts
// ownership pusė — task 0018/0056). Sidecar'as, o ne naujas laukas session-writes.json:
// to failo on-disk kontraktas (JSON string masyvas) turi 6+ skaitytojų, tad formos keitimas
// būtų lūžis jiems visiems. IO pusė (recordSessionWriteOwner po ledger lock'u,
// clearSessionWriteLedger) — VQ-502 hooks adapteriai; čia tik kelio taisyklė ir filtras,
// kurį jau dabar vartoja diagnozės adapteris.

import path from "node:path";
import { normalizeGitPath } from "../../domain/git/changes.js";

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
