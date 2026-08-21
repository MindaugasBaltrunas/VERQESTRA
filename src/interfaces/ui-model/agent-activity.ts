// Agentų grandinės aktyvumas dashboard'ui (etalonas: AG_loop ui/agent-parser.ts).
//
// Projekcija: užduoties `## Agentai` blokas plius Claude ndjson srauto log'as → kiekvieno
// agento būsena. Grandinė imama per TĄ PATĮ `parseAgentBlock`, kurį naudoja domain agentų
// atrankos politika — kitaip dashboard'as rodytų vieną grandinę, o preflight rinktųsi kitą.
//
// Visa sprendimų dalis GRYNA (`computeChainStatuses`, `buildAgentActivity`): ji projektuoja
// eilutes, o ne skaito failus, tad daugiaslot'inį elgesį galima įrodyti be jokios būsenos diske.

import path from "node:path";
import { parseAgentBlock } from "../../domain/policies/agent-selection.js";
import { tryParseJson } from "../../shared/json.js";

export type AgentStatus = "done" | "error" | "active" | "pending";

export type AgentActivity = {
  chain: string[];
  statuses: Record<string, AgentStatus>;
  currentAgent: string | null;
  currentActivity: string | null;
  taskId: string | null;
  claudeStatus: string | null;
  /**
   * Kaip vykdoma grandinė:
   * - `subagents` — Claude spawnina realius subagentus (matomi `Agent` įrankio kvietimai);
   * - `inline` — vienas headless Claude dirba pats (Read/Edit/Write), be subagentų;
   * - `idle` — nėra aktyvaus paleidimo.
   */
  mode: "subagents" | "inline" | "idle";
  updatedAt: string;
};

/**
 * Ar Claude statusas reiškia VYKSTANTĮ paleidimą. Skiria inline darbą nuo jau pasibaigusio, kad
 * grandinė nerodytų „dirba" ant užbaigtos užduoties.
 */
export function isLiveClaudeStatus(status: string | null | undefined): boolean {
  return status != null && /^(started|running|active|dispatch|preflight|delegated)$/i.test(status);
}

/** Rodoma grandinė iš užduoties teksto — ta pati taisyklė kaip agentų atrankos politikoje. */
export function parseChainFromTaskFile(content: string): string[] {
  const selection = parseAgentBlock(content);
  return selection.primary ? [selection.primary, ...selection.supporting] : selection.supporting;
}

type NdjsonObj = {
  type?: string;
  parent_tool_use_id?: string | null;
  message?: {
    content?: Array<{
      type?: string;
      name?: string;
      id?: string;
      tool_use_id?: string;
      is_error?: boolean;
      input?: Record<string, unknown>;
    }>;
  };
};

function parseNdjsonLine(line: string): NdjsonObj | undefined {
  if (!line.startsWith("{")) return undefined;
  const parsed = tryParseJson<NdjsonObj>(line);
  return parsed.ok ? parsed.value : undefined;
}

/** Trumpas įrankio kvietimo aprašas — tai, ką operatorius mato kaip „dabar daroma". */
function describeToolCall(name: string, input: Record<string, unknown>): string {
  const text = (key: string): string | undefined =>
    typeof input[key] === "string" ? (input[key]) : undefined;

  if (name === "Read" || name === "Write" || name === "Edit") {
    const filePath = text("file_path");
    if (filePath !== undefined) return `${name}: ${path.basename(filePath)}`;
  }
  if (name === "Bash") {
    const command = text("command");
    if (command !== undefined) return `Bash: ${command.slice(0, 50)}`;
  }
  if (name === "Glob" || name === "Grep") {
    const pattern = text("pattern");
    if (pattern !== undefined) return `${name}: ${pattern}`;
  }
  if (name === "Agent") {
    const subagent = text("subagent_type");
    if (subagent !== undefined) return `Spawning: ${subagent}`;
  }
  return name;
}

type AgentCallScan = {
  started: Map<string, string>;
  completedIds: Set<string>;
  erroredIds: Set<string>;
  activeId: string | null;
  lastActivityByAgentId: Map<string, string>;
  lastTopLevelActivity: string | null;
};

function parseAgentCalls(lines: readonly string[]): AgentCallScan {
  const started = new Map<string, string>();
  const completedIds = new Set<string>();
  const erroredIds = new Set<string>();
  const lastActivityByAgentId = new Map<string, string>();
  let lastTopLevelActivity: string | null = null;

  for (const line of lines) {
    const parsed = parseNdjsonLine(line);
    if (!parsed) continue;

    if (parsed.type === "assistant") {
      const parentId = parsed.parent_tool_use_id ?? null;
      for (const block of parsed.message?.content ?? []) {
        if (block.type !== "tool_use" || !block.id) continue;
        if (block.name === "Agent" && typeof block.input?.["subagent_type"] === "string") {
          started.set(block.id, block.input["subagent_type"]);
        }
        const description = describeToolCall(block.name ?? "", block.input ?? {});
        // Subagento kvietimas turi `parent_tool_use_id`; be jo tai viršutinio lygio Claude
        // darbas, kuris inline režime yra VIENINTELIS realaus darbo įrodymas.
        if (parentId) lastActivityByAgentId.set(parentId, description);
        else lastTopLevelActivity = description;
      }
    }

    if (parsed.type === "user") {
      for (const block of parsed.message?.content ?? []) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        completedIds.add(block.tool_use_id);
        if (block.is_error === true) erroredIds.add(block.tool_use_id);
      }
    }
  }

  let activeId: string | null = null;
  for (const [id] of started) {
    if (!completedIds.has(id)) {
      activeId = id;
      break;
    }
  }

  return { started, completedIds, erroredIds, activeId, lastActivityByAgentId, lastTopLevelActivity };
}

export type ChainStatusResult = {
  statuses: Record<string, AgentStatus>;
  currentAgent: string | null;
  currentActivity: string | null;
  subagentsUsed: boolean;
};

/** Gryna projekcija: grandinė + žalios ndjson eilutės → kiekvieno agento būsena. */
export function computeChainStatuses(chain: readonly string[], logLines: readonly string[]): ChainStatusResult {
  const scan = parseAgentCalls(logLines);
  const statuses: Record<string, AgentStatus> = {};
  let currentAgent: string | null = null;

  const completedAgents = new Set<string>();
  const erroredAgents = new Set<string>();
  for (const [id, agentType] of scan.started) {
    if (!scan.completedIds.has(id)) continue;
    if (scan.erroredIds.has(id)) erroredAgents.add(agentType);
    else completedAgents.add(agentType);
  }

  const activeAgent = scan.activeId ? (scan.started.get(scan.activeId) ?? null) : null;
  for (const agent of chain) {
    if (erroredAgents.has(agent)) {
      statuses[agent] = "error";
    } else if (completedAgents.has(agent)) {
      statuses[agent] = "done";
    } else if (activeAgent === agent) {
      statuses[agent] = "active";
      currentAgent = agent;
    } else {
      statuses[agent] = "pending";
    }
  }

  const currentActivity =
    (scan.activeId ? (scan.lastActivityByAgentId.get(scan.activeId) ?? null) : null) ?? scan.lastTopLevelActivity;

  return { statuses, currentAgent, currentActivity, subagentsUsed: scan.started.size > 0 };
}

export type AgentActivityInput = {
  taskContent: string;
  logContent: string;
  /** Vykdymo tapatybė: `claude-resume.json` arba tiesioginis slot'o įrodymas. */
  session: { taskId: string | null; status: string | null };
  now: Date;
};

/**
 * Visa aktyvumo forma iš jau perskaitytų tekstų.
 *
 * Inline režimas yra sąmoningas sprendimas, o ne kosmetika: dispatch'as paleidžia vieną headless
 * Claude, kuris dažnai dirba pats ir subagentų nespawnina — tada `started` tuščias ir VISA
 * grandinė liktų `pending`, nors darbas vyksta. Tokiu atveju pirmas nebaigtas agentas žymimas
 * `active`, o `currentActivity` rodo realų paskutinį įrankio kvietimą. Vartai — GYVAS statusas:
 * užbaigus užduotį grandinė nebeturi rodyti „dirba".
 */
export function buildAgentActivity(input: AgentActivityInput): AgentActivity {
  const chain = parseChainFromTaskFile(input.taskContent);
  let statuses: Record<string, AgentStatus> = {};
  let currentAgent: string | null = null;
  let currentActivity: string | null = null;
  let mode: AgentActivity["mode"] = "idle";

  if (chain.length > 0 && input.logContent) {
    const result = computeChainStatuses(chain, input.logContent.split(/\r?\n/));
    statuses = result.statuses;
    currentAgent = result.currentAgent;
    currentActivity = result.currentActivity;

    if (result.subagentsUsed) {
      mode = "subagents";
    } else if (isLiveClaudeStatus(input.session.status)) {
      mode = "inline";
      const firstPending = chain.find((agent) => statuses[agent] !== "done") ?? chain[0];
      if (firstPending) {
        statuses[firstPending] = "active";
        currentAgent = firstPending;
      }
    }
  }

  return {
    chain,
    statuses,
    currentAgent,
    currentActivity,
    taskId: input.session.taskId,
    claudeStatus: input.session.status,
    mode,
    updatedAt: input.now.toISOString(),
  };
}
