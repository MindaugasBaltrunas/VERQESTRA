// Commit-message rules: fallback antraštė/body iš pakeistų failų ir WIP-Task žymė —
// „bookkeeping, NE darbo įrodymas" kontraktas, kurį praleidžia visi evidence skaitytojai.
// Behaviour etalon: AG_loop policy/commit-message.ts (be node:path — grynas string kelias).

const scopeRoots = new Set(["apps", "modules", "packages", "workers", "doc", "tools", "tests"]);
const choreScopes = /^(?:AG\b|doc\b|logs\b|\.claude\b)/;

function normalizeFile(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function baseName(file: string): string {
  const parts = normalizeFile(file).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

// Scope = pirmieji du kelio segmentai žinomiems šakniniams katalogams (apps/web,
// modules/x, AG/tasks), kitaip pirmas segmentas — informatyvus prefiksas vietoj
// beprasmio paskutinio katalogo vardo.
function fileScope(file: string): string {
  const parts = normalizeFile(file).split("/").filter(Boolean);
  const head = parts[0];
  if (head === undefined) return "root";
  if ((head === "AG" || scopeRoots.has(head)) && parts.length > 1) return `${head}/${parts[1]}`;
  return head;
}

/**
 * Fallback commit antraštė, kai vykdytojas nepaliko commit žinutės.
 * Formatas: `<type>(<dominuojantis scope>[ +N]): <iki 3 failų vardų>[ (+N failų)]`.
 */
export function commitTitleFromFiles(files: string[]): string {
  if (files.length === 0) return "chore: atnaujinti failai";

  const counts = new Map<string, number>();
  for (const file of files) {
    const scope = fileScope(file);
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  const scopes = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([scope]) => scope);
  const primary = scopes[0] ?? "root";

  const names = Array.from(new Set(files.map((file) => baseName(file))));
  const shown = names.slice(0, 3);
  const hiddenCount = files.length - shown.length;

  const type = choreScopes.test(primary) ? "chore" : "feat";
  const scopeLabel = scopes.length > 1 ? `${primary} +${scopes.length - 1}` : primary;
  const suffix = hiddenCount > 0 ? ` (+${hiddenCount} failų)` : "";

  return `${type}(${scopeLabel}): ${shown.join(", ")}${suffix}`;
}

/**
 * Nukirstos sesijos WIP commit'o žymė. Trailer'is BODY'JE (ne `wip(...)` antraštė), nes
 * conventional-commits politika `wip` tipo nepriima ir antraštė būtų tyliai perrašyta.
 * Id gyvena TOJE PAČIOJE eilutėje kaip žymė: atskirti jie galėtų išsiskirti (amend,
 * cherry-pick) ir liktų id be žymės — commit'as, kurį evidence skaitytojai priimtų
 * kaip darbą. Neatskiriami jie klysta tik saugiąja puse.
 */
export const WIP_TASK_TRAILER = "WIP-Task";

/**
 * `WIP-Task: <id>` kaip VISA eilutė bet kurioje žinutės vietoje. Griežtas atitikmuo be
 * tarpų id viduje palieka prozai vietos (apie žymę galima RAŠYTI jos nesuaktyvinant);
 * registro nepaisoma sąmoningai — griežtesnė pusė: daugiau commit'ų laikoma bookkeeping'u.
 */
const wipTaskTrailerPattern = new RegExp(`^${WIP_TASK_TRAILER}:[ \\t]+\\S+[ \\t]*\\r?$`, "im");

/** Kiek pakeistų failų vardija automatinė žinutė. */
const FALLBACK_BODY_FILE_LIMIT = 10;

/** Stop-hook fallback'o body: pakeistų failų sąrašas plius WIP žymė, kai žinomas task'as. */
export function fallbackCommitBody(files: string[], taskId: string): string {
  return [...files.slice(0, FALLBACK_BODY_FILE_LIMIT).map((file) => `- ${file}`), ...wipCommitBodyLines(taskId)].join("\n");
}

/** Tuščias/nežinomas task id → tuščias sąrašas (interaktyvi sesija elgiasi kaip anksčiau). */
function wipCommitBodyLines(taskId: string): string[] {
  const id = taskId.trim();
  // Vientisas token'as: id su tarpu ar lūžiu suskaldytų trailer'į ir žymė nebeatpažintų
  // savęs — žymėtas commit'as taptų įrodymu.
  if (!/^\S+$/.test(id)) return [];
  return [
    "",
    "Sesija nutrūko nespėjusi parašyti commit žinutės — žemiau esanti žymė yra",
    "bookkeeping atsekamumui (kuriam task'ui priklauso šis commit'as), NE darbo įrodymas:",
    "įrodymų skaitytojai tokį commit'ą sąmoningai praleidžia.",
    `${WIP_TASK_TRAILER}: ${id}`,
  ];
}

/** True, kai žinutė nešioja WIP žymę — commit'as yra bookkeeping, NIEKADA ne darbo įrodymas. */
export function isWipCommitMessage(message: string): boolean {
  return wipTaskTrailerPattern.test(message);
}
