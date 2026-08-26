// Auto-OpenSpec change archyvavimas užbaigus task'ą (etalono task 0029).
//
// Autogen'as kiekvienam dispatch'ui gali sugeneruoti `openspec/changes/auto-<slug>/`,
// bet niekas jų neuždarydavo: aktyvių change'ų katalogas augo be ribų, o converge invariantas
// „aktyvus change = neužbaigtas darbas" nebegaliojo. Šis modulis yra ta trūkstama grandis tarp
// „taskas done" ir „change archyvuotas" — tas pats best-effort šablonas kaip architektūros
// mazgo sinchronizacija: done verdiktas NIEKADA nepriklauso nuo šios baigties.
//
// `agRoot` čia yra PARAMETRAS, o FS darbas eina per portą: modulis testuojamas prieš fake
// failų sistemą, ne prieš realų repozitorijos katalogą (etalone FS buvo tiesioginis
// node:fs/promises + core/fs — VERQESTRA application sluoksniui node:fs draudžiamas).
import path from "node:path";
import { slugFromTask } from "../task-planning/openspec-slug.js";

/**
 * Archyvavimo FS portas. `rename` adapteris (E4) privalo išlaikyti etalono
 * `withWin32RenameRetry` semantiką — win32 contention atveju bandoma pakartotinai.
 */
export type OpenSpecArchiveFsPort = {
  exists(absolutePath: string): Promise<boolean>;
  /** Failo tekstas arba `undefined`, kai failo nėra (nebuvimas — atsakymas, ne klaida). */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  writeTextFileAtomic(absolutePath: string, content: string): Promise<void>;
  /** Rekursinis katalogo sukūrimas (`mkdir -p` semantika). */
  makeDirectory(absoluteDir: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  /** Failų vardai kataloge; `[]` kai katalogo nėra. */
  listFiles(absoluteDir: string): Promise<string[]>;
};

/**
 * `changeDir` visose baigtyse — KANONINĖ `openspec/changes/<slug>` nuoroda (ta pati forma,
 * kurią rašo autogen'as), o ne absoliutus kelias: ji keliauja tiesiai į log eilutę, tad turi
 * būti stabili tarp mašinų.
 */
export type OpenSpecArchiveOutcome =
  | { action: "archived"; changeDir: string; markedTaskLines: number }
  | { action: "already-archived"; changeDir: string }
  | { action: "deferred-children"; changeDir: string; citedBy: string[] }
  | { action: "no-change"; reason: "missing" | "ambiguous"; candidates?: string[] }
  | { action: "error"; changeDir?: string; reason: string };

export type AutoChangeMatch =
  | { kind: "match"; slug: string; source: "spec-source" | "slug-reconstruction" }
  | { kind: "none" }
  | { kind: "ambiguous"; slugs: string[] };

/** Kanoninė nuoroda, kuria change'as vadinamas task tekste, log'e ir šio modulio baigtyse. */
function changeRef(slug: string): string {
  return `openspec/changes/${slug}`;
}

/**
 * Ištraukia task tekste minimų AUTO change'ų slug'us.
 *
 * Filtras `auto-` prefiksui yra saugiklis, o ne patogumas: vardinius change'us valdo žmogus,
 * ir task'o užbaigimas neturi teisės jų archyvuoti vien todėl, kad jie buvo paminėti
 * aprašyme. `archive/` ir `_template` niekada nėra kandidatai.
 */
export function extractAutoChangeSlugs(taskText: string): string[] {
  const pattern = /(?:AG\/)?openspec\/changes\/(?!archive\/|_template\b)([A-Za-z0-9_.-]+)/g;
  const slugs = new Set<string>();
  for (const match of taskText.matchAll(pattern)) {
    // Sakinio gale esantis taškas NĖRA slug'o dalis: `slugFromTask` generuoja tik
    // `[a-z0-9-]`, tad „... žr. openspec/changes/auto-x." be šio nukirpimo duotų ANTRĄ
    // kandidatą (`auto-x.`) šalia tos pačios change'o nuorodos su `/spec.md`, o du kandidatai
    // pagal kontraktą reiškia `ambiguous` — t. y. teisingas change'as liktų neuždarytas.
    const slug = match[1]?.replace(/\.+$/, "");
    if (slug && slug.startsWith("auto-")) {
      slugs.add(slug);
    }
  }
  return [...slugs];
}

/**
 * `- [ ]` -> `- [x]` visose tasks.md eilutėse, išsaugant įtrauką ir eilutės likutį.
 *
 * Fenced code blokai praleidžiami: change'ų tasks.md dažnai turi pavyzdinį checklist'ą
 * ``` bloke, ir jo „pažymėjimas" būtų turinio iškraipymas, ne progreso fiksavimas.
 *
 * Skaidoma `\r?\n`, o sujungiama vyraujančiu EOL: mišrių eilučių pabaigų faile (git autocrlf +
 * anksčiau LF'u rašytas autogen turinys) skaidymas vien `\r\n` paliktų `\n` VIDUJE „eilutės",
 * o tada nei fence sekimas, nei `^`-įtvirtinta pakaita ten nebeveiktų — dalis `- [ ]` liktų
 * nepažymėta. Kadangi failas šiame kelyje vis tiek perrašomas, EOL normalizacija yra pigesnė ir
 * nuspėjamesnė nei dalinis pažymėjimas.
 */
export function markTasksComplete(tasksMarkdown: string): { text: string; marked: number } {
  const eol = tasksMarkdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = tasksMarkdown.split(/\r?\n/);
  let inFence = false;
  let marked = 0;
  const next = lines.map((line) => {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    const replaced = line.replace(/^(\s*)- \[ \]/, "$1- [x]");
    if (replaced !== line) marked += 1;
    return replaced;
  });
  return { text: next.join(eol), marked };
}

/** Bucket'ai, kuriuose task'as vis dar laikomas nebaigtu darbu (terminaliniai — `done`, `error` — čia neįeina). */
const NON_TERMINAL_TASK_BUCKETS = ["queue", "active", "delegated", "human-review"] as const;

/**
 * Ar kuris nors NEBAIGTAS task'as (queue/active/delegated/human-review) cituoja šį `auto-<slug>`
 * change'ą per `## Spec source` (ar bet kurią kitą nuorodą, kurią atpažįsta `extractAutoChangeSlugs`).
 *
 * Egzistuoja tam, kad archyvavimas negalėtų uždaryti tėvo change'o, kol skaidymo vaikai (kurių
 * `## Spec source` cituoja tą patį `auto-<slug>`) dar nepasiekė terminalinio bucket'o — archyvinė
 * nuoroda preflight'e taptų nedispatch'inama.
 */
export async function findNonTerminalCitationsOfAutoChange(
  fs: OpenSpecArchiveFsPort,
  agRoot: string,
  slug: string,
): Promise<string[]> {
  const citedBy: string[] = [];
  for (const bucket of NON_TERMINAL_TASK_BUCKETS) {
    const bucketDir = path.join(agRoot, "tasks", bucket);
    const names = (await fs.listFiles(bucketDir)).filter((name) => name.toLowerCase().endsWith(".md")).sort();
    for (const fileName of names) {
      const filePath = path.join(bucketDir, fileName);
      const text = (await fs.readTextFileIfExists(filePath).catch(() => undefined)) ?? "";
      if (extractAutoChangeSlugs(text).includes(slug)) {
        citedBy.push(`tasks/${bucket}/${fileName}`);
      }
    }
  }
  return citedBy;
}

/**
 * Kurį change'ą uždaro šis taskas.
 *
 * 1) Task tekste esanti `openspec/changes/<slug>` nuoroda — tiksliausias šaltinis, nes ją
 *    įrašo pats autogen'as. Kelios skirtingos nuorodos yra dviprasmybė, ne pasirinkimas.
 * 2) Slug'o rekonstrukcija per `slugFromTask` — VIENINTELIS slug taisyklių šaltinis; kebab
 *    normalizacija ir 50 simbolių riba čia sąmoningai nedubliuojamos.
 *
 * Prefikso skenavimas (`auto-<taskId>-*`) NEĮGYVENDINTAS SĄMONINGAI: AG task numeriai
 * kartojasi tarp generacijų, tad plikas prefiksas anksčiau ar vėliau pataikytų į kitos
 * generacijos change'ą ir archyvuotų svetimą, dar neužbaigtą darbą. Fail-safe pasirinkimas —
 * geriau nieko nedaryti (`none`) nei archyvuoti ne tą.
 */
export async function resolveAutoChangeForTask(
  fs: OpenSpecArchiveFsPort,
  agRoot: string,
  taskId: string,
  doneTaskText: string,
): Promise<AutoChangeMatch> {
  const slugs = extractAutoChangeSlugs(doneTaskText);
  if (slugs.length === 1) {
    return { kind: "match", slug: slugs[0]!, source: "spec-source" };
  }
  if (slugs.length > 1) {
    return { kind: "ambiguous", slugs };
  }

  const slug = slugFromTask(taskId, doneTaskText);
  const changesRoot = path.join(agRoot, "openspec", "changes");
  const known =
    (await fs.exists(path.join(changesRoot, slug))) || (await fs.exists(path.join(changesRoot, "archive", slug)));
  return known ? { kind: "match", slug, source: "slug-reconstruction" } : { kind: "none" };
}

/**
 * Užbaigto task'o auto change'o archyvavimas: tasks.md pažymėjimas + perkėlimas į
 * `openspec/changes/archive/<slug>`.
 *
 * Tvarka KIETA — tasks.md pirma, perkėlimas po to: jei `rename` lūžta (win32 contention,
 * teisės), diske lieka aktyvus change su teisingai pažymėtu checklist'u, t. y. converge
 * invariantas vis tiek pagerėjęs, o kitas bandymas tiesiog užbaigs perkėlimą.
 *
 * Funkcija NIEKADA nemeta: kvietėjas ją vykdo jau PO to, kai taskas pripažintas done, tad
 * bet kokia klaida čia gali tik virsti log eilute.
 */
export async function archiveAutoOpenSpecChangeOnDone(
  fs: OpenSpecArchiveFsPort,
  agRoot: string,
  taskId: string,
  doneTaskFile: string,
): Promise<OpenSpecArchiveOutcome> {
  let ref: string | undefined;
  try {
    // Neperskaitomas done task failas nėra klaida: slug'o rekonstrukcija veikia ir iš vieno
    // task id, o tuščias tekstas tiesiog reiškia „nuorodos nėra".
    const doneTaskText = (await fs.readTextFileIfExists(doneTaskFile).catch(() => undefined)) ?? "";
    const match = await resolveAutoChangeForTask(fs, agRoot, taskId, doneTaskText);
    if (match.kind === "ambiguous") {
      return { action: "no-change", reason: "ambiguous", candidates: match.slugs };
    }
    if (match.kind === "none") {
      return { action: "no-change", reason: "missing" };
    }

    const changesRoot = path.join(agRoot, "openspec", "changes");
    const changeDir = path.join(changesRoot, match.slug);
    const archiveRoot = path.join(changesRoot, "archive");
    const archiveDir = path.join(archiveRoot, match.slug);
    ref = changeRef(match.slug);

    const activeExists = await fs.exists(changeDir);
    const archivedExists = await fs.exists(archiveDir);
    if (!activeExists) {
      // Idempotencija: pakartotinis to paties task'o uždarymas (retry, resume) nieko nerašo.
      return archivedExists ? { action: "already-archived", changeDir: ref } : { action: "no-change", reason: "missing" };
    }
    if (archivedExists) {
      // Susidūrimas: tas pats slug'as jau archyve. Sujungimas ar perrašymas čia būtų duomenų
      // praradimas, tad nedaroma NIEKO — sprendžia operatorius.
      return { action: "error", changeDir: ref, reason: "archive-target-exists" };
    }

    const citedBy = await findNonTerminalCitationsOfAutoChange(fs, agRoot, match.slug);
    if (citedBy.length > 0) {
      return { action: "deferred-children", changeDir: ref, citedBy };
    }

    // `tasks.md` nebuvimas nėra klaida — kai kurie change'ai jo tiesiog neturi.
    let markedTaskLines = 0;
    const tasksPath = path.join(changeDir, "tasks.md");
    const tasksText = await fs.readTextFileIfExists(tasksPath);
    if (tasksText !== undefined) {
      const marked = markTasksComplete(tasksText);
      if (marked.marked > 0) {
        await fs.writeTextFileAtomic(tasksPath, marked.text);
        markedTaskLines = marked.marked;
      }
    }

    await fs.makeDirectory(archiveRoot);
    await fs.rename(changeDir, archiveDir);
    return { action: "archived", changeDir: ref, markedTaskLines };
  } catch (error) {
    return {
      action: "error",
      ...(ref !== undefined ? { changeDir: ref } : {}),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
