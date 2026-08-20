// Auto-OpenSpec change slug taisyklė (task-planning klasterio pirmasis modulis, WBR VQ-305/VQ-304).
//
// Taisyklės SAVININKAS yra generatorius (task-planning autogen — VQ-305 3/3): jis slug'ą rašo,
// o `task-execution/openspec-archive.ts` tik rekonstruoja tą patį slug'ą uždarydamas change'ą.
// Todėl kebab normalizacija ir 50 simbolių riba gyvena ČIA vieną kartą — skaitytojai jų
// nedubliuoja (ledger'io taisyklė: dubliai jungiami, ne kopijuojami).

/** First non-empty `## Tikslas` line, if any — the task's human-readable goal. */
function firstTikslasLine(taskText: string): string | undefined {
  return taskText.match(/##\s*Tikslas\s*\n+([^\n]+)/)?.[1]?.trim() || undefined;
}

/**
 * Iš task id + teksto sukuria saugų kebab-case slug su `auto-` prefiksu, kad
 * sugeneruotus change'us būtų lengva atskirti nuo rankinių. Maks. ~60 simbolių.
 *
 * `taskId` VISADA įtraukiamas į slug'ą, kad skirtingi source task'ai negeneruotų to
 * paties change dir'o: kanoninė AG task antraštė yra plika `# Task`, tad vien iš
 * antraštės sudarytas slug'as susidurtų tarp task'ų.
 */
export function slugFromTask(taskId: string, taskText: string): string {
  const heading = taskText.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const titlePart = heading && heading.toLowerCase() !== "task" ? heading : (firstTikslasLine(taskText) ?? "");
  const base = [taskId, titlePart].filter(Boolean).join(" ") || "task";
  const slug = base
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return `auto-${slug || "task"}`;
}
