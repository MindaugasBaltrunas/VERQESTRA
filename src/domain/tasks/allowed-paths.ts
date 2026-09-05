// Canonical task allowed-paths parser — the SINGLE source of truth for reading the
// `## Failai` → `Leidžiama:` scope out of a task's Markdown. Pure string parsing; every
// scope reader resolves scope through here so "allowed path" means the exact same set on
// every path. Nothing may re-introduce a second copy.
// Behaviour etalon: AG_loop domain/tasks/allowed-paths.ts (dengta worker-task-ir fixture).

import { extractSection } from "../../shared/markdown.js";
import { err, ok, type Result } from "../../shared/result.js";

/** Why a task's allowed-paths scope could not be resolved to a non-empty set. */
export type AllowedPathsErrorCode = "missing_failai_section" | "empty_allowed_block";

export type AllowedPathsError = {
  code: AllowedPathsErrorCode;
  message: string;
};

// Diakritiką ir trailing tekstą toleruojantys žymekliai: tinka „Leidžiama:",
// „Leidziama keisti:", „Draudžiama:" ir „Draudziama:" (LLM dažnai rašo be ž).
const ALLOW_MARKER = /^\s*Leid[žz]iama\b/i;
const DENY_MARKER = /^\s*Draud[žz]iama\b/i;
const ALLOW_MARKER_STRIP = /^\s*Leid[žz]iama\b[^:]*:?/i;
const DENY_MARKER_STRIP = /^\s*Draud[žz]iama\b[^:]*:?/i;

/**
 * Ar eilutė yra vien `Leidžiama:` / `Draudžiama:` žymeklis be turinio. Eksportuojama, kad
 * `## Failai` skaitytojai atpažintų struktūrinę eilutę TA PAČIA taisykle, kuria ją
 * atpažįsta šis parseris — kitaip žymeklis atrodytų kaip prarastas turinys.
 */
export function isScopeMarkerLine(line: string): boolean {
  const text = (line ?? "").trim();
  if (!text) return false;
  if (ALLOW_MARKER.test(text)) return text.replace(ALLOW_MARKER_STRIP, "").trim() === "";
  if (DENY_MARKER.test(text)) return text.replace(DENY_MARKER_STRIP, "").trim() === "";
  return false;
}

/**
 * Iš `## Failai` sekcijos paima TIK `Leidžiama:` bloko tekstą (iki `Draudžiama:`).
 * `null`, kai `## Failai` sekcijos apskritai nėra — struktūruotas parseris atskiria
 * „trūksta sekcijos" nuo „sekcija yra, bet tuščia".
 */
function allowedBlock(taskText: string): string | null {
  const failai = extractSection(taskText, "## Failai");
  if (!failai) {
    return null;
  }
  const lines = failai.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => ALLOW_MARKER.test(line));
  if (startIdx === -1) {
    const denyIdx = lines.findIndex((line) => DENY_MARKER.test(line));
    return (denyIdx === -1 ? lines : lines.slice(0, denyIdx)).join("\n");
  }
  const rest = lines.slice(startIdx);
  rest[0] = (rest[0] ?? "").replace(ALLOW_MARKER_STRIP, "");
  const denyIdx = rest.findIndex((line, idx) => idx > 0 && DENY_MARKER.test(line));
  return (denyIdx === -1 ? rest : rest.slice(0, denyIdx)).join("\n");
}

/**
 * Simetriškas `allowedBlock`: iš `## Failai` paima TIK `Draudžiama:` bloką (iki kito
 * `Leidžiama:` žymeklio). `null`, kai nėra nei sekcijos, nei žymeklio — draudžiamų
 * sąrašas neprivalomas, todėl jo nebuvimas nėra klaida.
 */
function forbiddenBlock(taskText: string): string | null {
  const failai = extractSection(taskText, "## Failai");
  if (!failai) {
    return null;
  }
  const lines = failai.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => DENY_MARKER.test(line));
  if (startIdx === -1) {
    return null;
  }
  const rest = lines.slice(startIdx);
  rest[0] = (rest[0] ?? "").replace(DENY_MARKER_STRIP, "");
  const allowIdx = rest.findIndex((line, idx) => idx > 0 && ALLOW_MARKER.test(line));
  return (allowIdx === -1 ? rest : rest.slice(0, allowIdx)).join("\n");
}

/**
 * Vienos eilutės tokenų surinkimas: backtick tokenai turi pirmenybę; jei jų nėra —
 * kableliais atskirti bare tokenai (privalo turėti path/glob simbolį ir neturėti vidinių
 * tarpų, kad proza nebūtų klaidingai priimta kaip kelias).
 *
 * `- ` bullet eilutėje (etalono `## Failai` formatas) kelias yra TIK pirmas backtick
 * tokenas — likę backtick'ai toje pačioje eilutėje yra pagrindimo tekstas (pvz.
 * `` - `src/a/` — `..` traversal regresijos ``), ne papildomi keliai. Ne-bullet eilutės
 * (inline `Leidžiama: src/a.ts, src/b/**` forma) šia taisykle nesuvaržytos — ten kiekvienas
 * backtick tokenas jau yra atskiras kelias.
 */
function collectPathTokensFromLine(line: string, values: string[]): void {
  const backticked = Array.from(line.matchAll(/`([^`]+)`/g), (match) => (match[1] ?? "").trim()).filter(Boolean);
  if (backticked.length > 0) {
    const isBullet = /^\s*[-*+]\s/.test(line);
    values.push(...(isBullet ? backticked.slice(0, 1) : backticked));
    return;
  }
  for (const rawToken of line.split(",")) {
    const token = rawToken.replace(/^[\s*+-]+/, "").trim();
    if (token && !/\s/.test(token) && /[/*.]/.test(token)) {
      values.push(token);
    }
  }
}

/**
 * Suskaido `Leidžiama:`/`Draudžiama:` bloko eilutes į loginius įrašus: bullet eilutė ir iš
 * karto po jos einančios ĮTRAUKTOS (bet ne naujo bullet'o) tęstinės eilutės sulankstomos į
 * VIENĄ įrašą — etalono bullet'ai dažnai laužomi per kelias eilutes, o pagrindimo tekstas
 * tęstinėje eilutėje (pvz. backtick'ai) turi likti SAVO bullet'o dalimi, ne tapti atskira
 * eilute, kurios visi backtick'ai klaidingai virstų papildomais keliais.
 *
 * Įrašą nutraukia: tuščia eilutė, naujas bullet'as (`-`/`*`/`+`), arba neįtraukta (be
 * pradinio tarpo) eilutė — kiekviena tokia eilutė pradeda naują įrašą. Ne-bullet inline forma
 * (pirma bloko eilutė be bullet žymeklio) elgiasi kaip atskiras vieno-eilutės įrašas, nes prieš
 * ją nėra atviro įrašo, kurį būtų galima tęsti.
 */
function foldLogicalEntries(lines: string[]): string[] {
  const entries: string[] = [];
  let openEntry = false;
  for (const line of lines) {
    if (!line.trim()) {
      openEntry = false;
      continue;
    }
    const isBullet = /^\s*[-*+]\s/.test(line);
    const isIndented = /^\s/.test(line);
    if (openEntry && isIndented && !isBullet) {
      entries[entries.length - 1] = `${entries[entries.length - 1] ?? ""} ${line.trim()}`;
      continue;
    }
    entries.push(line);
    openEntry = true;
  }
  return entries;
}

/**
 * Struktūruotas kanoninis parseris: `ok(paths)` kai randami leidžiami keliai, arba `err`:
 *   - `missing_failai_section` — task'e nėra `## Failai` sekcijos;
 *   - `empty_allowed_block` — sekcija yra, bet `Leidžiama:` bloke nėra kelių tokenų.
 * Extension-less tokenai (pvz. `Dockerfile`) ĮTRAUKIAMI — jie yra tikros ribos.
 */
export function parseAllowedPaths(taskMarkdown: string): Result<string[], AllowedPathsError> {
  const block = allowedBlock(taskMarkdown ?? "");
  if (block === null) {
    return err({ code: "missing_failai_section", message: "task has no `## Failai` section" });
  }
  const values: string[] = [];
  for (const entry of foldLogicalEntries(block.split(/\r?\n/))) {
    collectPathTokensFromLine(entry, values);
  }
  if (values.length === 0) {
    return err({ code: "empty_allowed_block", message: "`## Failai` has no `Leidžiama:` path tokens" });
  }
  return ok(values);
}

/**
 * Lenient adapteris virš `parseAllowedPaths`: tiek „nėra sekcijos", tiek „tuščias blokas"
 * grąžina `[]` — istorinis kontraktas, visi skaitytojai tuščią rinkinį traktuoja kaip
 * „nėra scope"; struktūruotą priežastį gauna kvietėjai per `parseAllowedPaths`.
 */
export function allowedPaths(taskMarkdown: string): string[] {
  const parsed = parseAllowedPaths(taskMarkdown);
  return parsed.ok ? parsed.value : [];
}

/**
 * Kanoninis leistino kelio glob matcher'is: `**` = bet koks gylis, `/*` = vienas lygis,
 * `*` kelio viduryje = vienas segmentas, be wildcard'o — prefikso containment.
 * Case-SENSITIVE (skirtingai nuo scheduling scope-lock, kuris lygina case-insensitive
 * failų sistemos semantika) — „ar kelias telpa į task'o scope" reiškia tą patį diagnozėje
 * (domain/diagnosis/dispositions) ir integracijoje (application/integration). Etalone tai
 * buvo trys pažodinės kopijos su „privalo keistis kartu" komentaru; čia kopija yra VIENA.
 */
export function matchesAllowedPath(file: string, allowed: string): boolean {
  if (allowed === "**" || allowed === "*") return true;
  if (allowed.endsWith("/**")) {
    const prefix = allowed.slice(0, -3);
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  if (allowed.endsWith("/*")) {
    const prefix = allowed.slice(0, -2);
    return file.startsWith(`${prefix}/`) && !file.slice(prefix.length + 1).includes("/");
  }
  if (allowed.includes("*")) return wildcardPatternMatches(file, allowed);
  return file === allowed || file.startsWith(`${allowed.replace(/\/$/, "")}/`);
}

/**
 * Bendrinis wildcard glob'as kelio VIDURYJE ar SUFIKSE: `*` = vienas segmentas (be `/`),
 * `**` = bet koks gylis. Etalono 2026-08-07 regresija (task 1134): neinterpretuoti tokie
 * šablonai paversdavo VISUS pakeitimus „outside allowed paths".
 * `**` po kurio iškart seka `/` reiškia „nulis ar daugiau katalogų", ne „bent vienas": glob'as
 * su viduriniu dvigubos žvaigždutės segmentu (pvz. tsx failai po `ui-app/src`) privalo atitikti
 * ir tiesiogiai `src` kataloge esantį failą, ne tik giliau įdėtus (task 178).
 */
export function wildcardPatternMatches(file: string, pattern: string): boolean {
  const source = pattern
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) =>
      part === "**/"
        ? "(?:.*/)?"
        : part === "**"
          ? ".*"
          : part === "*"
            ? "[^/]*"
            : part.replace(/[$()+.?[\\\]^{|}]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`).test(file);
}

/**
 * `## Failai` → `Draudžiama:` keliai, surinkti TA PAČIA token taisykle kaip leidžiami.
 * Tuščias rezultatas = „draudžiamų kelių nenurodyta" — draudimai yra papildomas signalas,
 * leidžiami keliai lieka vienintelis kietas redagavimo vartas.
 */
export function forbiddenPaths(taskMarkdown: string): string[] {
  const block = forbiddenBlock(taskMarkdown ?? "");
  if (block === null) {
    return [];
  }
  const values: string[] = [];
  for (const entry of foldLogicalEntries(block.split(/\r?\n/))) {
    collectPathTokensFromLine(entry, values);
  }
  return values;
}
