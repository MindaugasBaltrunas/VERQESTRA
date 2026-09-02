// VQ-503 (1/5) testai — agentų grandinės aktyvumas. Svarbiausia, ką jie pin'ina: klaidingas
// subagentas duoda `error`, ne `done`; inline režimas (Claude dirba pats, be subagentų) nerodo
// tuščios `pending` grandinės, bet TIK kol statusas gyvas; ir tiesioginis slot'o įrodymas
// išjungia globalaus checkpoint'o skaitymą, nes tas aprašo KITĄ slot'ą.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  buildAgentActivity,
  computeChainStatuses,
  isLiveClaudeStatus,
  parseChainFromTaskFile,
} from "../interfaces/ui-model/agent-activity.js";
import {
  readAgentActivity,
  type AgentActivityPorts,
} from "../interfaces/ui-model/agent-activity-reader.js";

const RUNTIME = path.resolve("/repo/vq");
const NOW = new Date("2026-08-21T12:00:00.000Z");

const TASK = `# Task\n\n## Agentai\n- primary: architect\n- supporting: implementer, reviewer\n`;

function assistant(blocks: unknown[], parentId?: string): string {
  return JSON.stringify({
    type: "assistant",
    ...(parentId === undefined ? {} : { parent_tool_use_id: parentId }),
    message: { content: blocks },
  });
}

function toolResult(id: string, isError = false): string {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] },
  });
}

function fakePorts(files: Record<string, string> = {}): AgentActivityPorts {
  const store = new Map(Object.entries(files));
  return {
    fs: { readTextFileIfExists: (p) => Promise.resolve(store.get(p)) },
    now: () => NOW,
  };
}

test("parseChainFromTaskFile: grandinė imama ta pačia taisykle kaip agentų atranka", () => {
  assert.deepEqual(parseChainFromTaskFile(TASK), ["architect", "implementer", "reviewer"]);
  assert.deepEqual(parseChainFromTaskFile("# Task\nbe agentų bloko"), []);
});

test("parseChainFromTaskFile: task 138 incidento fraze nebegimdo prozos čipų", () => {
  // 2026-09-01 gyvas incidentas 097 dispatch'e: ši fraze rodydavo čipus „privaloma",
  // „grandinė", „šia", „tvarka:" — sakinio žodžius, ne agentus.
  const incident =
    "# Task\n\n## Agentai\nPRIVALOMA grandinė šia tvarka: readme-guard -> documenter -> reviewer\n";
  assert.deepEqual(parseChainFromTaskFile(incident), ["readme-guard", "documenter", "reviewer"]);

  const prose = "# Task\n\n## Agentai\nreadme-guard eina pirmas ir grąžina ribų santrauką.\n";
  assert.deepEqual(parseChainFromTaskFile(prose), ["readme-guard eina pirmas ir grąžina ribų santrauką"]);
});

test("computeChainStatuses: klaida lieka error, o ne done", () => {
  const lines = [
    assistant([{ type: "tool_use", id: "a1", name: "Agent", input: { subagent_type: "architect" } }]),
    toolResult("a1", true),
    assistant([{ type: "tool_use", id: "a2", name: "Agent", input: { subagent_type: "implementer" } }]),
    toolResult("a2"),
    assistant([{ type: "tool_use", id: "a3", name: "Agent", input: { subagent_type: "reviewer" } }]),
  ];

  const result = computeChainStatuses(["architect", "implementer", "reviewer"], lines);
  assert.deepEqual(result.statuses, { architect: "error", implementer: "done", reviewer: "active" });
  assert.equal(result.currentAgent, "reviewer");
  assert.equal(result.subagentsUsed, true);
});

test("computeChainStatuses: aktyvaus subagento darbas rodomas prieš viršutinio lygio kvietimą", () => {
  const lines = [
    assistant([{ type: "tool_use", id: "a1", name: "Agent", input: { subagent_type: "architect" } }]),
    assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }]),
    assistant([{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/repo/src/app.ts" } }], "a1"),
  ];

  const result = computeChainStatuses(["architect"], lines);
  // Subagento paskutinis kvietimas nugali globalų: būtent jis yra to agento darbas.
  assert.equal(result.currentActivity, "Read: app.ts");

  // Be aktyvaus subagento lieka viršutinio lygio kvietimas — inline darbo įrodymas.
  const inline = computeChainStatuses(
    ["architect"],
    [assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }])],
  );
  assert.equal(inline.currentActivity, "Bash: pnpm test");
  assert.equal(inline.subagentsUsed, false);
});

test("computeChainStatuses: sugadintos ir ne JSON eilutės praleidžiamos be klaidos", () => {
  const result = computeChainStatuses(
    ["architect"],
    ["", "ne json", "{ nebaigtas", assistant([{ type: "tool_use", id: "a1", name: "Agent", input: { subagent_type: "architect" } }])],
  );
  assert.equal(result.statuses["architect"], "active");
});

test("buildAgentActivity: inline režimas rodo darbą, bet TIK kol statusas gyvas", () => {
  const logContent = assistant([{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/a.ts" } }]);

  const live = buildAgentActivity({
    taskContent: TASK,
    logContent,
    session: { taskId: "890", status: "started" },
    now: NOW,
  });
  assert.equal(live.mode, "inline");
  assert.equal(live.currentAgent, "architect");
  assert.equal(live.statuses["architect"], "active");
  assert.equal(live.currentActivity, "Edit: a.ts");
  assert.equal(live.updatedAt, NOW.toISOString());

  // Užbaigta užduotis: grandinė nebeturi rodyti „dirba".
  const finished = buildAgentActivity({
    taskContent: TASK,
    logContent,
    session: { taskId: "890", status: "finished" },
    now: NOW,
  });
  assert.equal(finished.mode, "idle");
  assert.equal(finished.currentAgent, null);
  assert.equal(finished.statuses["architect"], "pending");

  assert.equal(isLiveClaudeStatus("dispatch"), true);
  assert.equal(isLiveClaudeStatus("done"), false);
  assert.equal(isLiveClaudeStatus(null), false);
});

test("buildAgentActivity: be grandinės arba be log'o lieka tuščia idle būsena", () => {
  const activity = buildAgentActivity({
    taskContent: "# Task",
    logContent: "",
    session: { taskId: null, status: null },
    now: NOW,
  });
  assert.deepEqual(activity.chain, []);
  assert.deepEqual(activity.statuses, {});
  assert.equal(activity.mode, "idle");
});

test("readAgentActivity: tiesioginis slot'o įrodymas IŠJUNGIA globalų checkpoint'ą", async () => {
  const files = {
    [path.join(RUNTIME, "supervisor", "reformulated-task.md")]: TASK,
    [path.join(RUNTIME, "logs", "claude-last.log")]: "",
    [path.join(RUNTIME, "state", "claude-resume.json")]: JSON.stringify({ task_id: "999", status: "started" }),
  };

  const global = await readAgentActivity(fakePorts(files), RUNTIME);
  assert.deepEqual({ taskId: global.taskId, claudeStatus: global.claudeStatus }, {
    taskId: "999",
    claudeStatus: "started",
  });

  // Globalus checkpoint'as aprašo KITĄ slot'ą — jo skaitymas čia būtų melas, ne informacija.
  const slot = await readAgentActivity(fakePorts(files), RUNTIME, {
    session: { taskId: "890", status: "running" },
  });
  assert.deepEqual({ taskId: slot.taskId, claudeStatus: slot.claudeStatus }, {
    taskId: "890",
    claudeStatus: "running",
  });
});

test("readAgentActivity: nesami ir sugadinti šaltiniai duoda tuščią būseną, ne klaidą", async () => {
  const empty = await readAgentActivity(fakePorts(), RUNTIME);
  assert.deepEqual(empty.chain, []);
  assert.equal(empty.taskId, null);

  const broken = await readAgentActivity(
    fakePorts({ [path.join(RUNTIME, "state", "claude-resume.json")]: "{ nebaigtas" }),
    RUNTIME,
  );
  assert.equal(broken.claudeStatus, null);
});

test("readAgentActivity: bandymo keliai perrašo globalius šaltinius", async () => {
  const attemptTask = path.join(RUNTIME, "runtime", "attempt", "task.md");
  const attemptLog = path.join(RUNTIME, "runtime", "attempt", "logs", "claude-last.log");
  const ports = fakePorts({
    [path.join(RUNTIME, "supervisor", "reformulated-task.md")]: "# Kita užduotis",
    [attemptTask]: TASK,
    [attemptLog]: assistant([{ type: "tool_use", id: "a1", name: "Agent", input: { subagent_type: "architect" } }]),
  });

  const activity = await readAgentActivity(ports, RUNTIME, { taskFilePath: attemptTask, logPath: attemptLog });
  assert.deepEqual(activity.chain, ["architect", "implementer", "reviewer"]);
  assert.equal(activity.statuses["architect"], "active");
  assert.equal(activity.mode, "subagents");
});
