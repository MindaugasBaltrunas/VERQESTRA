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
 */
function collectPathTokensFromLine(line: string, values: string[]): void {
  const backticked = Array.from(line.matchAll(/`([^`]+)`/g), (match) => (match[1] ?? "").trim()).filter(Boolean);
  if (backticked.length > 0) {
    values.push(...backticked);
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
  for (const line of block.split(/\r?\n/)) {
    collectPathTokensFromLine(line, values);
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
  for (const line of block.split(/\r?\n/)) {
    collectPathTokensFromLine(line, values);
  }
  return values;
}
