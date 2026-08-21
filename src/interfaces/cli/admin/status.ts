// `status` CLI adapteris (etalonas: interfaces/cli/status/index.ts): TIK skaitantis
// operatoriaus paviršius — eilės būsena, einamasis task'as, tokenų analitika, stop įrodymas,
// resume taškai, paskutinis sprendimas ir git būsena.
//
// Ši komanda niekada nieko nekuria ir nemutuoja (išskyrus ensureDirs): attempt namespace'as
// skaitomas read-only, o stop įrodymo portas paduodamas be telemetrijos — statuso peržiūra
// nėra vykdymo kelias ir neturi teisės rašyti į runtime.
//
// Sugadinti būsenos JSON failai NIEKADA nenutraukia ataskaitos: statusas yra diagnostikos
// paviršius, į kurį operatorius kreipiasi BŪTENT tada, kai kažkas sulūžę.

import path from "node:path";
import { taskBuckets } from "../../../domain/tasks/buckets.js";
import type { TokenAnalyticsSnapshot } from "../../../application/learning/token-analytics-snapshot.js";
import { consoleCliIo, type CliIo } from "../registry.js";

/** Stop įrodymo vaizdas, susiaurintas iki to, ką statusas rodo (diagnose klasteris skaito platesnį). */
export type StatusStopEvidenceView = {
  /** `attempt` | `legacy` — kuris įrodymas priimtas (operatorius turi tai matyti). */
  origin: string;
  status?: string;
  reason?: string;
  corrupted: boolean;
};

/** Resume checkpoint'o vaizdas — laukai optional, nes failas rašomas palaipsniui. */
export type StatusResumeView = {
  actor?: string;
  status?: string;
  phase?: string;
  task_id?: string;
  log_file?: string;
  log_lines?: number;
  next_action?: string;
};

/** Paskutinio supervizoriaus sprendimo vaizdas (rodomi laukai 1:1 su etalonu). */
export type StatusDecisionView = {
  verdict?: string;
  task_id?: string;
  selected_model?: string;
  target_agent_chain?: string[];
  target_agent?: string;
  risk_level?: string;
  retry_key?: string;
  reason?: string;
};

export type StatusPorts = {
  ensureDirs(): Promise<void>;
  countMarkdownFiles(absoluteDir: string): Promise<number>;
  listMarkdownFiles(absoluteDir: string): Promise<string[]>;
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  /** Einamojo task'o stop įrodymas; tuščias taskId — be įrodymo. */
  readStopEvidence(taskId: string): Promise<StatusStopEvidenceView>;
  /** Tokenų analitikos snapshot'as arba `null`, kai jo dar nėra. */
  readTokenAnalytics(): Promise<TokenAnalyticsSnapshot | null>;
  /** `git status --porcelain` išvestis; tuščia eilutė — švarus medis. */
  gitStatus(): Promise<string>;
};

export type StatusCommandDeps = {
  ports: StatusPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  io?: CliIo;
};

function parseJsonOrEmpty<T>(raw: string | undefined): Partial<T> {
  if (raw === undefined || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
}

export async function statusCommand(deps: StatusCommandDeps): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const root = path.resolve(deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");
  const agRoot = path.join(root, "AG");
  const statePath = (...segments: string[]): string => path.join(runtimeRoot, "state", ...segments);

  await deps.ports.ensureDirs();

  io.out("AG status");
  io.out(`root: ${root}`);
  io.out("");
  io.out("tasks:");
  for (const bucket of taskBuckets) {
    const count = await deps.ports.countMarkdownFiles(path.join(agRoot, "tasks", bucket));
    io.out(`  ${`${bucket}:`.padEnd(14)} ${count}`);
  }

  io.out("");
  for (const bucket of taskBuckets) {
    const files = await deps.ports.listMarkdownFiles(path.join(agRoot, "tasks", bucket));
    if (files.length === 0) continue;
    io.out(`${bucket}:`);
    for (const file of files) io.out(`  - ${file}`);
  }

  const currentTaskId = await deps.ports.readTextFileIfExists(statePath("current-task-id"));
  const currentTaskFile = await deps.ports.readTextFileIfExists(statePath("current-task-file"));
  const claudeExit = await deps.ports.readTextFileIfExists(statePath("claude-last-exit-code"));
  const stableRef = await deps.ports.readTextFileIfExists(statePath("stable-ref"));

  if (currentTaskId) io.out(`current_task_id: ${currentTaskId}`);
  if (currentTaskFile) io.out(`current_task_file: ${currentTaskFile}`);
  if (claudeExit) io.out(`claude_last_exit_code: ${claudeExit}`);
  if (stableRef) io.out(`stable_ref: ${stableRef}`);

  await renderTokenAnalytics(deps, io);
  await renderStopEvidence(deps, io, currentTaskId ?? "");
  await renderResumePoints(deps, io, statePath);
  await renderLatestDecision(deps, io, path.join(runtimeRoot, "supervisor", "decision.json"));

  const gitOutput = await deps.ports.gitStatus();
  io.out("");
  io.out("git_status:");
  if (gitOutput) {
    io.out("");
    io.out(gitOutput);
  }
  return 0;
}

/**
 * Tokenų analitika ilgą laiką buvo WRITE-ONLY: vienintelis jos skaitytojas buvo UI grafikas,
 * tad terminale dirbantis operatorius kaštų signalo nematydavo. `status` yra vieta, kur jis
 * ir taip žiūri prieš paleisdamas kitą bangą.
 */
async function renderTokenAnalytics(deps: StatusCommandDeps, io: CliIo): Promise<void> {
  const analytics = await deps.ports.readTokenAnalytics().catch(() => null);
  if (!analytics) return;

  const tasks = Math.max(1, analytics.totals.uniqueTasks);
  io.out("");
  io.out("token_analytics:");
  io.out(`  tasks:            ${analytics.totals.uniqueTasks}`);
  io.out(`  tokens_per_task:  ${Math.round(analytics.totals.totalTokens / tasks)}`);
  io.out(`  repair_share:     ${(analytics.repairShare * 100).toFixed(1)}%`);
  io.out(`  cache_hit_rate:   ${(analytics.cacheHitRate * 100).toFixed(1)}%`);
}

/**
 * Einamojo task'o attempt `stop-state.json` yra autoritetas; globalus stop failas rodomas tik
 * kaip fallback ir pažymimas `claude_stop_source`, kad operatorius matytų, kuris įrodymas priimtas.
 */
async function renderStopEvidence(deps: StatusCommandDeps, io: CliIo, currentTaskId: string): Promise<void> {
  const evidence = await deps.ports.readStopEvidence(currentTaskId.trim());
  if (evidence.status) {
    io.out(`claude_stop_status: ${evidence.status}`);
    io.out(`claude_stop_reason: ${evidence.reason ?? ""}`);
    io.out(`claude_stop_source: ${evidence.origin}`);
    return;
  }
  if (evidence.corrupted) {
    io.out("claude_stop_status: <corrupted>");
    io.out(`claude_stop_source: ${evidence.origin}`);
  }
}

async function renderResumePoints(
  deps: StatusCommandDeps,
  io: CliIo,
  statePath: (...segments: string[]) => string,
): Promise<void> {
  const supervisor = parseJsonOrEmpty<StatusResumeView>(
    await deps.ports.readTextFileIfExists(statePath("supervisor-resume.json")),
  );
  const claude = parseJsonOrEmpty<StatusResumeView>(
    await deps.ports.readTextFileIfExists(statePath("claude-resume.json")),
  );
  if (!supervisor.status && !claude.status) return;

  io.out("");
  io.out("resume_points:");
  for (const resume of [supervisor, claude]) {
    if (!resume.actor) continue;
    io.out(
      `  ${resume.actor}: ${resume.status ?? "none"} ${resume.phase ?? ""} task=${resume.task_id ?? ""} log=${resume.log_file ?? ""} lines=${resume.log_lines ?? 0} next=${resume.next_action ?? ""}`,
    );
  }
}

async function renderLatestDecision(deps: StatusCommandDeps, io: CliIo, decisionPath: string): Promise<void> {
  const decision = parseJsonOrEmpty<StatusDecisionView>(await deps.ports.readTextFileIfExists(decisionPath));
  if (Object.keys(decision).length === 0) return;

  io.out("");
  io.out("latest_decision:");
  io.out(
    JSON.stringify(
      {
        verdict: decision.verdict,
        task_id: decision.task_id,
        selected_model: decision.selected_model,
        target_agent_chain: decision.target_agent_chain,
        target_agent: decision.target_agent,
        risk_level: decision.risk_level,
        retry_key: decision.retry_key,
        reason: decision.reason,
      },
      null,
      2,
    ),
  );
}
