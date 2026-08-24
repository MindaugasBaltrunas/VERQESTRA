// Pure task-identity rules: what a task file is — its number, slug, whether it carries a
// leading `# Task` heading or is a superseded stub, and the canonical ledger key. No IO.
// Behaviour etalon: AG_loop domain/tasks/identity.ts + core/paths.ts taskIdFromFile
// (WBR VQ-201: taskLedgerKey unifies the two historical copies of the ledger-key rule).

import { toPosixPath } from "../../shared/paths.js";

/**
 * Filename segment of a path, splitting on both `/` and `\` regardless of host platform
 * (a pure stand-in for `path.basename`). Trailing separators are ignored.
 */
function basename(fileOrPath: string): string {
  const trimmed = fileOrPath.replace(/[/\\]+$/, "");
  const lastSeparator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSeparator === -1 ? trimmed : trimmed.slice(lastSeparator + 1);
}

/** Leading task number embedded in a queue/state filename: `<NNN>-<slug>.md`. */
const TASK_FILENAME_PATTERN = /^(\d+)-.+\.md$/i;

/**
 * Split-child filename shape produced by a task splitter: `<parentStem>-<NN>-<childSlug>`
 * (NN = 02, 03, …) — tells a deliberate parent/child hierarchy apart from a collision.
 */
const SPLIT_CHILD_STEM_PATTERN = /^(.+)-\d{2}-.+$/;

/** Goal body under the real (`## Tikslas`) or back-compat (`## Goal`) heading. */
const GOAL_HEADING_PATTERN = /^## (?:Goal|Tikslas)\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/im;

/** Default slug length cap for generated task filenames. */
export const DEFAULT_TASK_SLUG_MAX_LENGTH = 56;

export type TaskIdentity = {
  /** Leading number parsed from the filename. */
  number: number;
  /** Normalized goal text (collapsed whitespace), read from `## Tikslas`/`## Goal`. */
  goal: string;
};

/** Filename without its `.md` extension (accepts a bare name or a full path). */
export function taskFileStem(fileOrPath: string): string {
  return basename(fileOrPath).replace(/\.md$/i, "");
}

/**
 * Canonical ledger/state key for a task file: POSIX-normalized separators BEFORE the stem
 * (a Windows-style path must yield the same key on Linux), then identifier sanitization.
 * The ONE rule both historical AG_loop copies computed — byte-for-byte their surface.
 */
export function taskLedgerKey(fileOrPath: string): string {
  return taskFileStem(toPosixPath(fileOrPath)).replace(/[^A-Za-z0-9_.-]/g, "-");
}

/** Leading task number, or undefined when the filename is not a recognizable task file. */
export function taskNumberFromFilename(fileOrPath: string): number | undefined {
  const match = TASK_FILENAME_PATTERN.exec(basename(fileOrPath));
  const captured = match?.[1];
  return captured === undefined ? undefined : Number.parseInt(captured, 10);
}

/**
 * Parent stem of a split-child filename, or undefined when the name is not a split child.
 * Greedy: returns the LONGEST candidate; when the child slug itself contains `-NN-`
 * sequences, use {@link splitChildParentStemCandidates} and verify against the task set.
 */
export function splitChildParentStem(fileOrPath: string): string | undefined {
  const match = SPLIT_CHILD_STEM_PATTERN.exec(taskFileStem(fileOrPath));
  return match?.[1];
}

/**
 * Every possible parent stem of a split-child filename — one candidate per `-NN-<rest>`
 * split point, longest first. Overlapping candidates are allowed (e.g. `-02-03-`).
 */
export function splitChildParentStemCandidates(fileOrPath: string): string[] {
  const stem = taskFileStem(fileOrPath);
  const candidates: string[] = [];
  const splitPoint = /-\d{2}-/g;
  let match: RegExpExecArray | null;
  while ((match = splitPoint.exec(stem)) !== null) {
    const prefix = stem.slice(0, match.index);
    const suffix = stem.slice(match.index + match[0].length);
    if (prefix && suffix) candidates.push(prefix);
    splitPoint.lastIndex = match.index + 1;
  }
  return candidates.sort((a, b) => b.length - a.length);
}

/**
 * Text of the first level-1 (`#`) ATX heading, or undefined when there is none. Level-2+
 * headings (the Step-0 preamble) are skipped, so this is the document's LEADING heading.
 */
function firstLevelOneHeading(content: string): string | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^#(?!#)\s+\S/.test(line)) {
      return line.replace(/^#\s+/, "").trim();
    }
  }
  return undefined;
}

/**
 * True when the document's leading level-1 heading is `# Task`. A superseded stub whose
 * first heading is `# Superseded` (original `# Task` demoted below the fold) is rejected.
 */
export function hasLeadingTaskHeading(content: string): boolean {
  const heading = firstLevelOneHeading(content);
  return heading !== undefined && /^Task(?:\s|$)/i.test(heading);
}

/** Explicit superseded-stub predicate: the file leads with a `# Superseded` heading. */
export function isSupersededStub(content: string): boolean {
  const heading = firstLevelOneHeading(content);
  return heading !== undefined && /^Superseded(?:\s|$)/i.test(heading);
}

/** Normalized goal text, or undefined when no `## Tikslas`/`## Goal` section exists. */
export function extractTaskGoal(content: string): string | undefined {
  const match = GOAL_HEADING_PATTERN.exec(content);
  const captured = match?.[1];
  return captured === undefined ? undefined : captured.trim().replace(/\s+/g, " ");
}

/**
 * True when the markdown is a recognizable task: it leads with `# Task` and declares a
 * goal. Superseded stubs and non-task documents return false.
 */
export function recognizeTask(content: string): boolean {
  return hasLeadingTaskHeading(content) && extractTaskGoal(content) !== undefined;
}

/**
 * Combined identity for a task file, or undefined when the filename is not a task file or
 * the content is not a recognizable task — the single "what task is this?" entry point.
 */
export function identifyTask(fileOrPath: string, content: string): TaskIdentity | undefined {
  const number = taskNumberFromFilename(fileOrPath);
  if (number === undefined) return undefined;
  const goal = extractTaskGoal(content);
  if (!hasLeadingTaskHeading(content) || goal === undefined) return undefined;
  return { number, goal };
}

/**
 * Diakritiniai ženklai → ASCII pagrindas (2026-08-24, operatoriaus radinys: „užduočių tekstuose
 * dingsta lietuviškos raidės").
 *
 * `[^a-z0-9]` kiekvieną `ą č ę ė į š ų ū ž` pavertė brūkšneliu, tad „Įvardyti sąrašą" virsdavo
 * `vardyti-sara` — raidės ne pakeičiamos, o IŠKRENTA, ir žodis nustoja būti žodžiu. Vardas
 * sąraše yra vienintelis dalykas, kuris vieną užduotį skiria nuo kitos, tad tai ne kosmetika.
 *
 * Sprendimas yra transliteracija, ne ne-ASCII vardai: failų vardai lieka ASCII (jie keliauja per
 * git, Windows ir POSIX), o žodis lieka perskaitomas — `ivardyti-sarasa`.
 *
 * NFD suskaido raidę į bazę + kirtį, tad bendrieji Europos diakritikai (á, ö, ç) susitvarko
 * savaime; `ė ų ū` po NFD irgi virsta `e u u`. Lieka tik tai, ko Unikodas neskaido — `ž š č`
 * turi savo bazes, o vokiškas `ß` ir šiaurietiškos `ø æ` bazės neturi visai.
 */
const SLUG_TRANSLITERATION: ReadonlyArray<readonly [RegExp, string]> = [
  [/[žźż]/g, "z"],
  [/[šśş]/g, "s"],
  [/[čćç]/g, "c"],
  [/[ñń]/g, "n"],
  [/[đð]/g, "d"],
  [/ß/g, "ss"],
  [/[øœ]/g, "o"],
  [/æ/g, "ae"],
  [/ł/g, "l"],
  [/þ/g, "th"],
];

/** `Įvardyti sąrašą` → `ivardyti-sarasa`. Rezultatas visada ASCII. */
export function transliterateForSlug(value: string): string {
  let normalized = value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const [pattern, replacement] of SLUG_TRANSLITERATION) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized;
}

/**
 * Stable kebab-case slug for a task title, matching the task-splitter filename
 * normalization. `maxLength` reproduces a caller-specific cap (48 filenames, 56 matching).
 */
export function taskSlug(title: string, maxLength: number = DEFAULT_TASK_SLUG_MAX_LENGTH): string {
  return (
    transliterateForSlug(title)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLength) || "task"
  );
}

/**
 * Slug'ai, kuriais galima ATPAŽINTI jau esantį failą: dabartinis ir senasis (iki transliteracijos).
 *
 * Be šito `converge` kiekvieną lietuvišką užduotį, sukurtą pagal senąją taisyklę, paskelbtų
 * dingusia: jos failo varde yra `vardyti-sara`, o planas dabar skaičiuoja `ivardyti-sarasa`.
 * Kūrimas naudoja TIK naują formą — senoji lieka vien atpažinimui, ir nė vienas failas
 * nepervadinamas.
 */
export function taskSlugCandidates(
  title: string,
  maxLength: number = DEFAULT_TASK_SLUG_MAX_LENGTH,
): string[] {
  const legacy =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLength) || "task";
  const current = taskSlug(title, maxLength);
  return current === legacy ? [current] : [current, legacy];
}
