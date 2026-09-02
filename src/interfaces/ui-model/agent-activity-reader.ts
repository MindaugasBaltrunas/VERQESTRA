// Aktyvumo šaltinių skaitymas (etalonas: AG_loop ui/agent-parser.ts `readAgentActivity`).
// Sprendimas — `agent-activity.ts`; čia tik iš kur imami tekstai.
//
// Kiekvienas šaltinis yra OPTIONAL ir krenta į tą patį globalų failą, kurį modulis skaitė iki
// daugiaslot'inės bangos. Tipas atsirado todėl, kad nuo dviejų lygiagrečių worker slot'ų
// globalūs failai nustojo būti vieno vykdymo įrodymu: `logs/claude-last.log` yra tik paskutinio
// rašytojo veidrodis, o `reformulated-task.md` / `claude-resume.json` aprašo vienintelį slot'ą.
// Antro slot'o grandinė, suprojektuota ant jų, rodytų SVETIMĄ užduotį.

import path from "node:path";
import { tryParseJson } from "../../shared/json.js";
import { buildAgentActivity, type AgentActivity } from "./agent-activity.js";

export type UiModelFsPort = {
  /** Failo tekstas arba `undefined`, kai failo nėra (nebuvimas — atsakymas, ne klaida). */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
};

export type AgentActivityPorts = {
  fs: UiModelFsPort;
  now?: () => Date;
};

export type AgentActivitySources = {
  /** Claude ndjson srauto log'as — bandymo `logs/claude-last.log` kanalas. */
  logPath?: string;
  /** Užduoties tekstas, iš kurio imama `## Agentai` grandinė — bandymo `task.md`. */
  taskFilePath?: string;
  /**
   * Vykdymo tapatybė, kai kviečiantysis ją JAU turi iš tiesioginio įrodymo (bangos snapshot'o
   * live slot'ų). Nurodžius, globalus `claude-resume.json` visai neskaitomas: jis aprašo kitą
   * slot'ą, tad jo `status`/`task_id` čia būtų MELAS, o ne praleista informacija.
   */
  session?: { taskId: string; status: string };
  /**
   * Kviečiantysis JAU žino, kad vykdymas gyvas (worktree dispatch, gyva lease ir pan.) ir turi
   * arba neturi tiesioginio log'o kelio. Nurodžius `true`, numatytasis kritimas į
   * `<runtimeRoot>/logs/claude-last.log` IŠJUNGIAMAS: tas failas yra tik paskutinio bandymo
   * veidrodis, o gyvame kontekste be aiškaus `logPath` teisinga reikšmė yra TUŠČIA veikla,
   * ne svetimo (galbūt 8 valandų senumo) paleidimo turinys.
   */
  liveExecution?: boolean;
};

type ResumeJson = { status?: string; phase?: string; task_id?: string };

export async function readAgentActivity(
  ports: AgentActivityPorts,
  runtimeRoot: string,
  sources: AgentActivitySources = {},
): Promise<AgentActivity> {
  const taskPath = sources.taskFilePath ?? path.join(runtimeRoot, "supervisor", "reformulated-task.md");
  // Gyvame kontekste be aiškaus `logPath` NĖRA numatytojo kritimo į veidrodį: tas failas
  // aprašo paskutinį BANDYMĄ, ne šitą vykdymą, tad jo skaitymas čia būtų svetima veikla.
  const logPath = sources.liveExecution
    ? sources.logPath
    : (sources.logPath ?? path.join(runtimeRoot, "logs", "claude-last.log"));

  const [taskContent, logContent, resumeRaw] = await Promise.all([
    ports.fs.readTextFileIfExists(taskPath),
    logPath ? ports.fs.readTextFileIfExists(logPath) : Promise.resolve(undefined),
    sources.session
      ? Promise.resolve(undefined)
      : ports.fs.readTextFileIfExists(path.join(runtimeRoot, "state", "claude-resume.json")),
  ]);

  const resume = parseResume(resumeRaw);
  return buildAgentActivity({
    taskContent: taskContent ?? "",
    logContent: logContent ?? "",
    session: {
      taskId: sources.session?.taskId ?? resume.task_id ?? null,
      status: sources.session?.status ?? resume.status ?? null,
    },
    now: ports.now?.() ?? new Date(),
  });
}

/** Sugadintas checkpoint'as yra „nežinau", ne klaida: dashboard'as dėl telemetrijos nekrenta. */
function parseResume(raw: string | undefined): ResumeJson {
  if (raw === undefined) return {};
  const parsed = tryParseJson<unknown>(raw);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return {};
  }
  return parsed.value;
}
