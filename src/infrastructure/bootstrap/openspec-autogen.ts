// OpenSpec change auto-generavimas source task'ui (etalonas: AG_loop orchestrator/
// architecture/openspec-autogen.ts). Čia gyvena realus `BootstrapSpecPorts.generateChange`
// tiekėjas — headless Claude kvietimas — ir jo deterministinis template fallback (task 882).
// VERQESTRA keliai: change'ai rašomi į `<agRoot>/openspec/changes/<slug>` (spec'ai lieka AG/
// medyje — paketo kontraktas), o konfigas/state — vq runtime šaknyje (žr. deps.runtimeRoot).

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runClaudeHeadless } from "../adapters/claude-headless.js";
import { extractResultField } from "../adapters/claude-usage.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

/** OpenSpec change failai, kuriuos generuojam (atitinka `_template/` struktūrą). */
const CHANGE_FILES = ["proposal", "design", "spec", "tasks"] as const;
type ChangeFileKey = (typeof CHANGE_FILES)[number];

/** First non-empty `## Tikslas` line, if any — the task's human-readable goal. */
function firstTikslasLine(taskText: string): string | undefined {
  return taskText.match(/##\s*Tikslas\s*\n+([^\n]+)/)?.[1]?.trim() || undefined;
}

/**
 * Task title for spec text. A canonical AG task heading is the bare `# Task`
 * (the real title lives in `## Tikslas`), so a heading of exactly "Task" is
 * ignored in favor of the goal line. Falls back to the task id.
 */
export function titleFromTask(taskId: string, taskText: string): string {
  const heading = taskText.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading && heading.toLowerCase() !== "task") {
    return heading;
  }
  return firstTikslasLine(taskText) ?? taskId ?? "Auto-generated change";
}

/**
 * Iš task id + teksto sukuria saugų kebab-case slug su `auto-` prefiksu, kad
 * sugeneruotus change'us būtų lengva atskirti nuo rankinių. Maks. ~60 simbolių.
 *
 * `taskId` VISADA įtraukiamas į slug'ą, kad skirtingi source task'ai negeneruotų to
 * paties change dir'o: kanoninė AG task antraštė yra plika `# Task`, tad vien iš
 * antraštės slug'as būtų „auto-task" visiems ir auto-openspec change'ai vienas kitą
 * perrašytų (etalono task 882). Task id (failo stem) jau unikalus, tad jis garantuoja
 * atskirumą; title fragmentas lieka dėl skaitomumo.
 */
export function slugFromTask(taskId: string, taskText: string): string {
  const heading = taskText.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const titlePart = heading && heading.toLowerCase() !== "task" ? heading : firstTikslasLine(taskText) ?? "";
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

/** Ištraukia pirmą JSON objektą iš LLM atsakymo (tiesioginis, fenced arba įterptas). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const candidates: string[] = [];
  if (trimmed.startsWith("{")) {
    candidates.push(trimmed);
  }
  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence?.[1]) {
    candidates.push(fence[1].trim());
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Signature of `runClaudeHeadless` this module delegates to. Injectable so tests never invoke headless Claude. */
export type ClaudeHeadlessRunner = (
  prompt: string,
  model: string,
  stateDir: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

export type GenerateOpenSpecChangeDeps = {
  runClaude?: ClaudeHeadlessRunner;
  /**
   * `vq` runtime šaknis konfigo (`config/architecture-rules.md`) ir headless state failams.
   * Nenurodžius išvedama kaip `<agRoot>/../vq` — AG ir vq medžiai gyvena po ta pačia
   * projekto šaknimi, tad sibling išvedimas atitinka kanoninį layout'ą.
   */
  runtimeRoot?: string;
};

function defaultRuntimeRoot(agRootDir: string): string {
  return path.join(path.dirname(path.resolve(agRootDir)), "vq");
}

/**
 * Auto-generuoja OpenSpec change'ą source task'ui, kuris neturi aktyvaus
 * `openspec/changes/<id>/`. Sukuria 4 failus iš task teksto + architektūros
 * taisyklių, naudodamas headless Claude. Grąžina kanoninę
 * `openspec/changes/<slug>` nuorodą, arba `null` jei nepavyko (kvietėjas tada
 * krenta į human_review — jokio begalinio retry).
 */
export async function generateOpenSpecChange(
  taskText: string,
  taskId: string,
  agRootDir: string,
  model: string,
  deps: GenerateOpenSpecChangeDeps = {},
): Promise<string | null> {
  const slug = slugFromTask(taskId, taskText);
  const runtimeRoot = deps.runtimeRoot ?? defaultRuntimeRoot(agRootDir);
  const architectureRules = (
    (await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "config", "architecture-rules.md"))) ?? ""
  ).slice(0, 1800);

  const prompt = `Tu esi AG OpenSpec generatorius. Iš žemiau pateiktos užduoties sukurk OpenSpec change'ą.

Privalai grąžinti TIK JSON objektą be jokio markdown, komentarų ar paaiškinimų, su tiksliai šiais laukais (kiekvienas — pilnas Markdown failo turinys):
{
  "proposal": "# Proposal\\n\\n## Why ...\\n## Scope ...\\n## Out Of Scope ...\\n## Architecture Boundaries ...",
  "design": "# Design\\n\\n## Approach ...\\n## Data Flow ...\\n## Risks ...",
  "spec": "# Spec Delta\\n\\n## Added ...\\n## Changed ...\\n## Acceptance Criteria ...",
  "tasks": "# Tasks\\n\\n- [ ] ...\\n\\n## AG Queue Tasks ..."
}

Reikalavimai:
- Laikykis projekto architektūros ribų (žr. žemiau). Nerašyk produkto kodo, tik specifikaciją.
- proposal turi turėti antraštes: ## Why, ## Scope, ## Out Of Scope, ## Architecture Boundaries.
- design turi turėti: ## Approach, ## Data Flow, ## Risks.
- spec turi turėti: ## Added, ## Changed, ## Acceptance Criteria.
- tasks turi turėti checklist punktus ir ## AG Queue Tasks sekciją.
- Architecture Boundaries privalo nurodyti paliečiamą modulį/app/paketą, Reads/Writes DB schemas ir Job types (arba "nėra").

## Task ID
${taskId}

## Užduotis
${taskText.slice(0, 6000)}

## Architektūros pagrindinės taisyklės
${architectureRules}`;

  const runClaude = deps.runClaude ?? runClaudeHeadless;
  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await runClaude(prompt, model, path.join(runtimeRoot, "state"));
  } catch {
    return null;
  }
  if (result.code !== 0) {
    return null;
  }

  const parsed = parseJsonObject(extractResultField(result.stdout));
  if (!parsed) {
    return null;
  }

  const contents = new Map<ChangeFileKey, string>();
  for (const key of CHANGE_FILES) {
    const value = parsed[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }
    contents.set(key, value);
  }

  const changeDir = path.join(agRootDir, "openspec", "changes", slug);
  try {
    await mkdir(changeDir, { recursive: true });
    await Promise.all(
      CHANGE_FILES.map((key) =>
        writeFile(path.join(changeDir, `${key}.md`), `${contents.get(key)!.trimEnd()}\n`, "utf8"),
      ),
    );
  } catch {
    return null;
  }

  return `openspec/changes/${slug}`;
}

/** Signature of the deterministic template fallback used when LLM generation fails. */
export type TemplateOpenSpecWriter = (
  taskText: string,
  taskId: string,
  agRootDir: string,
) => Promise<string | null>;

/**
 * Deterministinis OpenSpec change template fallback (etalono task 882). Kai LLM generavimas
 * (`generateOpenSpecChange`) nepavyksta (ne-nulinis exit, neparsinamas JSON, trūkstamas
 * laukas), preflight neturi kristi į human-review — source task pats yra intencijos
 * įrodymas, tad iš jo teksto sukuriamas minimalus, bet validus change'as be jokio LLM.
 * Grąžina kanoninę `openspec/changes/<slug>` nuorodą arba `null` TIK kai net template
 * įrašymas į diską nepavyksta (tuomet kvietėjas krenta į human-review).
 *
 * Skirtingai nei bootstrap flow (`generateProjectImplementationSpec`), kuris silpnų
 * įrodymų atveju SĄMONINGAI negrąžina spec'o, čia įrodymas visada yra — task jau eilėje.
 */
export const writeTemplateOpenSpecChange: TemplateOpenSpecWriter = async (taskText, taskId, agRootDir) => {
  const slug = slugFromTask(taskId, taskText);
  const title = titleFromTask(taskId, taskText);
  const goal = firstTikslasLine(taskText) ?? title;

  const contents: Record<ChangeFileKey, string> = {
    proposal: `# Proposal

## Why
${goal}

## Scope
- Implement the queued task \`${taskId}\` as specified in its task file.

## Out Of Scope
- Anything not required by the task's \`## Veiksmas\`.

## Architecture Boundaries
- Follow the project architecture rules and stay within the task's \`## Failai\` scope.
`,
    design: `# Design

## Approach
${goal}

## Data Flow
- No new data flow beyond what the task requires.

## Risks
- Auto-generated deterministic template; refine the change if the work grows.
`,
    spec: `# Spec Delta

## Added
- ${title}

## Changed
- See the task's \`## Veiksmas\`.

## Acceptance Criteria
- The task's \`## Patikra\` checks pass.
`,
    tasks: `# Tasks

- [ ] ${title}

## AG Queue Tasks
- ${taskId}
`,
  };

  const changeDir = path.join(agRootDir, "openspec", "changes", slug);
  try {
    await mkdir(changeDir, { recursive: true });
    await Promise.all(
      CHANGE_FILES.map((key) => writeFile(path.join(changeDir, `${key}.md`), contents[key], "utf8")),
    );
  } catch {
    return null;
  }

  return `openspec/changes/${slug}`;
};
