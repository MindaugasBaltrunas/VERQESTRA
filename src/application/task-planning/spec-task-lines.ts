// Bendras spec/openspec tasks.md checkbox parseris (etalono orchestrator/tasks/task-splitter.ts
// DUP-10 dalis, VQ-304 3/3 — namas task-planning klasteryje, nes jį vartoja spec → queue task
// generacija ir converge (VQ-305)).
//
// DUP-10: vienas parseris AG/spec ir AG/openspec tasks.md abiem — etalone converge turėjo
// atskirą `parseOpenSpecTasks` su privalomu checkbox ir be `*` bullet palaikymo. Šis parseris
// yra abiejų taisyklių aibių unija: checkbox neprivalomas (jei nėra, `complete` = false),
// `-`/`*` bullet, completion tracking iš `[x]`/`[X]`, evidence-annotation (pvz.
// "Sentence. (2026-07-01, task 823: ...)") ir žymimosios kabutės nukerpamos iš title,
// baigiamieji taškai nuimami (queue task šablonas juos vėl prideda).

export type SpecTaskLine = {
  index: number;
  title: string;
  complete: boolean;
};

const evidenceAnnotationPattern = /\.\s*\(\d{4}-\d{2}-\d{2},\s*task\s+\d+:[\s\S]*$/i;

export function parseSpecTaskLines(tasksMarkdown: string, options: { requireCheckbox?: boolean } = {}): SpecTaskLine[] {
  const tasks: SpecTaskLine[] = [];
  for (const line of tasksMarkdown.split(/\r?\n/)) {
    const match = line.match(/^[-*]\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/);
    if (options.requireCheckbox && match?.[1] === undefined) {
      continue;
    }
    if (!match) {
      continue;
    }

    const withoutEvidence = match[2]!.replace(evidenceAnnotationPattern, "").trim();
    const title = withoutEvidence.replace(/`/g, "").replace(/[.]+$/g, "").trim();
    if (!title) {
      continue;
    }
    tasks.push({ index: tasks.length + 1, title, complete: match[1]?.toLowerCase() === "x" });
  }
  return tasks;
}
