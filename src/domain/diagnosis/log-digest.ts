// Pure log-digest rules for the diagnosis prompt. No node/FS/process imports and no side
// effects: the FS side (log skaitymas) lieka E5 interfaces sluoksnyje, kuris paduoda žalią
// tekstą per šias funkcijas. Behaviour etalon: AG_loop domain/diagnosis/log-digest.ts.
//
// 2026-08-06 token auditas: diagnozės promptas buvo 185 807 simbolių, iš kurių 147 527 (79,4 %)
// — žalias `--include-partial-messages` stream-json srautas, o 25 260 — neapdorota quality-gates
// uodega, kurioje beveik vien PRAĖJUSIŲ testų vardai. Modeliui reikia klaidos esmės, ne
// event envelope'ų: šios funkcijos iš to paties šaltinio palieka tik sprendimui reikšmingą
// turinį. Visos yra grynos ir determinuotos, tad promptas lieka atkuriamas ir cache'uojamas.

/** Kiek simbolių paliekama kiekvienai promptų sekcijai. */
export const DIAGNOSIS_DIGEST_LIMITS = {
  claudeLog: 8000,
  claudeLogReduced: 3000,
  qualityGates: 6000,
  qualityGatesReduced: 2500,
} as const;

function clipTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…(nukirpta ${text.length - maxChars} simb.)\n${text.slice(text.length - maxChars)}`;
}

/** Paskutinio `"type":"result"` įvykio `result` laukas — sesijos santrauka be event srauto. */
function resultTextFromStreamJson(logText: string): string | undefined {
  const lines = logText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (!line.includes('"type":"result"')) continue;
    try {
      const envelope = JSON.parse(line) as Record<string, unknown>;
      if (envelope["type"] !== "result") continue;
      const result = envelope["result"];
      if (typeof result === "string" && result.trim()) return result;
      const error = envelope["error"];
      if (typeof error === "string" && error.trim()) return error;
      const subtype = envelope["subtype"];
      if (typeof subtype === "string" && subtype.trim()) return `(result be teksto, subtype=${subtype})`;
    } catch {
      // dalinė/ne-JSON eilutė — ieškom toliau aukštyn
    }
  }
  return undefined;
}

const ERROR_LINE = /\b(error|failed|failure|exception|BLOCKED|not-allowlisted|✖|FAIL)\b/i;

/** Ne-JSON eilutės (launcher antraštės, stderr) — jos jau yra žmogui skaitomos. */
function plainTextLines(logText: string): string[] {
  return logText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("{"));
}

/**
 * Diagnozei reikšmingas vykdytojo log turinys: sesijos `result` tekstas plius bet kokios
 * ne-JSON klaidų eilutės. Jei `result` įvykio nėra (nukirsta/žuvusi sesija), grąžinama žalio
 * log'o uodega — tokiu atveju būtent ji ir yra vienintelis įrodymas.
 */
export function digestClaudeStreamLog(logText: string, maxChars: number = DIAGNOSIS_DIGEST_LIMITS.claudeLog): string {
  const raw = logText ?? "";
  if (!raw.trim()) return "(tuščias)";

  const sections: string[] = [];
  const resultText = resultTextFromStreamJson(raw);
  if (resultText) sections.push(`### Sesijos rezultatas\n${resultText.trim()}`);

  const errorLines = plainTextLines(raw).filter((line) => ERROR_LINE.test(line));
  if (errorLines.length > 0) {
    // Paskutinės klaidų eilutės informatyviausios: jos aprašo gedimą, kuriuo sesija baigėsi.
    sections.push(`### Klaidų eilutės (${errorLines.length})\n${errorLines.slice(-40).join("\n")}`);
  }

  if (sections.length === 0) {
    return clipTail(raw, maxChars);
  }
  return clipTail(sections.join("\n\n"), maxChars);
}

/**
 * Quality-gates log'as be praėjusių patikrų triukšmo: paliekamos `exit_code`, komandų antraštės
 * ir klaidų eilutės su nedideliu kontekstu aplink. Jei nieko panašaus nerandama (pvz. visos
 * patikros praėjo), grąžinama įprasta uodega.
 */
export function digestQualityGatesLog(
  logText: string,
  maxChars: number = DIAGNOSIS_DIGEST_LIMITS.qualityGates,
): string {
  const raw = logText ?? "";
  if (!raw.trim()) return "(tuščias)";

  const lines = raw.split(/\r?\n/);
  const keep = new Set<number>();
  for (const [index, line] of lines.entries()) {
    const interesting = ERROR_LINE.test(line) || /^(?:#|command:|exit_code:)/i.test(line.trim());
    if (!interesting) continue;
    for (let offset = -3; offset <= 3; offset += 1) {
      const neighbour = index + offset;
      if (neighbour >= 0 && neighbour < lines.length) keep.add(neighbour);
    }
  }
  if (keep.size === 0) return clipTail(raw, maxChars);

  const ordered = [...keep].sort((left, right) => left - right);
  const picked: string[] = [];
  let previous = -1;
  for (const index of ordered) {
    if (previous >= 0 && index > previous + 1) picked.push("…");
    picked.push(lines[index] ?? "");
    previous = index;
  }
  return clipTail(picked.join("\n"), maxChars);
}

/**
 * Tik šio task'o retry įrašai. Anksčiau į promptą keliaudavo VISAS retry žurnalas (visų
 * task'ų istorija, auganti be ribų), nors sprendimui reikšmingas tik šio task'o skaitiklis.
 * Neparse'inamas turinys grąžinamas kaip yra — diagnozė neturi nutylėti sugadintos būsenos.
 *
 * Rakto formatas — pagal RAŠYTOJĄ `application/task-execution/retry-counts.ts:63-64`:
 * `task:<taskId>` (task skaitiklis) ir `error:<retryKey>` (klaidos parašo skaitiklis), plius
 * legacy formos, kurias migruoja `:51` — `<taskId>` ir `<taskId>:…`.
 *
 * Task 193 (auditas 2026-09-05, #32): buvęs `key.includes(taskId)` task'ui `010` įtraukdavo
 * `task:0100-…` ir `task:1010-…` — svetimą istoriją, klaidinančią diagnozę. Dabar lyginamos
 * tikslios rašytojo formos.
 *
 * `error:<retryKey>` raktai NEĮTRAUKIAMI sąmoningai: `retryKey` yra klaidos parašas, ne task id
 * (`interfaces/cli/dispatch/retry-guard.ts:109`), tad jis dalijamas tarp task'ų ir čia — turint
 * tik JSON'ą ir `taskId` — su šiuo task'u nesusiejamas. Substring sutapimas tokį susiejimą tik
 * imituodavo.
 */
export function retryCountsForTask(retryCountsJson: string, taskId: string): string {
  const raw = (retryCountsJson ?? "").trim();
  if (!raw) return "{}";

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;

  const scoped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === `task:${taskId}` || key === taskId || key.startsWith(`${taskId}:`)) scoped[key] = value;
  }
  return JSON.stringify(scoped, null, 2);
}
