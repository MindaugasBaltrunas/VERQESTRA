// VQ-304 (3 dalis): orchestrator/tasks likučio unit testai — split plano taisyklės, vaikų id
// ir idempotentiškas enqueue, TaskGraph importas + blocked maršrutizavimas, repair prompt
// scope perkėlimas, ledger'io seen-before taisyklė, task-events kontraktas ir spec checkbox
// parseris. Jokios realios FS — tik fake portai.
import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskSplitPlan, shouldSplitTask } from "../application/task-execution/task-splitting.js";
import { measureTaskSize } from "../domain/tasks/size.js";
import {
  childTaskId,
  contentSignature,
  enqueueChildTasks,
  missingChildTaskSections,
  type ChildTaskEnqueuePorts,
  type ChildTaskLedgerEntry,
} from "../application/task-execution/enqueue-child-tasks.js";
import {
  importTaskGraphFromMarkdown,
  routeBlockedTasksToHumanReview,
  taskNodeFromMarkdown,
  type BucketTaskFile,
} from "../application/task-execution/task-graph-import.js";
import { carryTaskScopeIntoRepairPrompt, taskRepairPath } from "../application/task-execution/repair-prompt.js";
import {
  normalizeTaskLedgerState,
  taskLedgerEntrySeenBefore,
} from "../application/task-execution/task-ledger-rules.js";
import { phaseFailureReason, tailChars } from "../application/task-execution/task-events-model.js";
import { parseSpecTaskLines } from "../application/task-planning/spec-task-lines.js";
import type { TaskBucket } from "../domain/tasks/index.js";

const LIMITS = { maxLines: 10, maxAllowedPaths: 2, maxDomains: 1, maxActionBullets: 2 };

test("childTaskId: forma <bazė>-<raidės>-<NN>-<slug>, biudžetas ir kartos paveldėjimas", () => {
  const first = childTaskId("1210-loop-watchdog", 2, "CLI dispatch fix");
  assert.match(first, /^1210-a-02-cli-dispatch/);
  assert.ok(first.length <= 59, `id ${first} netelpa į 59 (64 - kolizijos rezervas)`);

  // Naujos formos vaikas kaip tėvas: bazė paveldima, raidės ilgėja (karta gilyn).
  const nested = childTaskId(first, 3, "deeper part");
  assert.match(nested, /^1210-ab-03-/);

  // Nenumeruotas tėvas → bazė = jo slug'as.
  assert.match(childTaskId("claude-audit-repair", 2, "x"), /^claude-audit-repair-a-02-/);

  // Žymuo saturuojasi ties 99, o tikroji eilė gyvena raidėse.
  assert.match(childTaskId("0042", 150, "many"), /^0042-[a-z]+-99-/);

  // Absurdiškai ilgas tėvo id vis tiek palieka vietos slug'ui.
  const long = childTaskId(`${"9".repeat(40)}-labai-ilgas-tevas`, 2, "child title");
  assert.ok(long.length <= 59);
  assert.match(long, /-a-02-.{8,}/, "slug'as niekada nedingsta");
});

test("missingChildTaskSections: fatalios tik HARD sekcijos", () => {
  const full = "# Task\n## Spec source\nx\n## Tikslas\ny\n## Veiksmas\n- a\n## Stop\nz\n";
  assert.deepEqual(missingChildTaskSections(full), []);
  assert.deepEqual(missingChildTaskSections("## Tikslas\ny\n"), ["# Task", "## Spec source", "## Veiksmas", "## Stop"]);
  const withoutSoft = full; // be ## Agentai/## Failai/## Patikra — vis tiek validus
  assert.deepEqual(missingChildTaskSections(withoutSoft), []);
});

const OVERSIZED_TASK = `# Task

## Spec source
openspec/changes/demo

## Tikslas
Didelis darbas.

## Agentai
coder

## Failai
Leidžiama:
- \`src/a/one.ts\`
- \`src/a/two.ts\`
- \`src/a/three.ts\`

## Veiksmas
- pirmas
- antras
- trečias
- ketvirtas

## Patikra
- \`pnpm test\`

## Stop
Sustoti, kai patikros praeina.

## Neįtraukta
- Kita.
`;

test("buildTaskSplitPlan: perteklius skaidomas, vaikai blokuojami tėvu, sekcijos paveldimos", () => {
  const metrics = measureTaskSize(OVERSIZED_TASK);
  assert.ok(shouldSplitTask(metrics, LIMITS).length > 0);

  const plan = buildTaskSplitPlan(OVERSIZED_TASK, "0042", LIMITS);
  assert.equal(plan.required, true);
  assert.ok(plan.parts >= 2);
  assert.equal(plan.child_tasks.length, plan.parts - 1);
  assert.doesNotMatch(plan.first_task, /## Dependencies/, "pirma dalis be blocked_by");
  for (const child of plan.child_tasks) {
    assert.match(child.claude_task, /## Dependencies\n- blocked_by: 0042/);
    assert.match(child.claude_task, /## Spec source\nopenspec\/changes\/demo/);
    assert.match(child.title, /— part \d+$/);
  }
});

function makeEnqueuePorts(maxDepth = 3): {
  ports: ChildTaskEnqueuePorts;
  ledger: Map<string, ChildTaskLedgerEntry>;
  written: Map<string, string>;
  logs: string[];
} {
  const ledger = new Map<string, ChildTaskLedgerEntry>();
  const written = new Map<string, string>();
  const logs: string[] = [];
  const ports: ChildTaskEnqueuePorts = {
    readLedger: async () => Object.fromEntries(ledger),
    recordLedgerEntry: async (key, entry) => void ledger.set(key, entry),
    exists: async (filePath) => written.has(filePath),
    writeUniqueTaskFile: async (preferredPath, content) => {
      const target = written.has(preferredPath) ? preferredPath.replace(/\.md$/, "-2.md") : preferredPath;
      written.set(target, content);
      return target;
    },
    maxSplitDepth: async () => maxDepth,
    log: async (message) => void logs.push(message),
    nowIso: () => "2026-08-20T00:00:00.000Z",
  };
  return { ports, ledger, written, logs };
}

const VALID_CHILD = "# Task\n## Spec source\nopenspec/changes/demo\n## Tikslas\nVaikas.\n## Veiksmas\n- daryk\n## Stop\nStop.\n";

test("enqueueChildTasks: gylio vartai PRIEŠ rašymą ir validacija PRIEŠ pirmą vaiką", async () => {
  const { ports, written } = makeEnqueuePorts(1);
  // Tėvas pats yra ledger'io vaikas (depth 1) → kitas gylis 2 > max 1.
  const { ports: gated, ledger, written: gatedWritten } = makeEnqueuePorts(1);
  ledger.set("0001#2", { signature: "s", file: "/ag/tasks/queue/0042-a-02-x.md", recorded_at: "t", depth: 1 });
  const depthResult = await enqueueChildTasks(gated, "/ag", "0042-a-02-x", {
    child_tasks: [{ title: "vaikas", claude_task: VALID_CHILD }],
  });
  assert.deepEqual(depthResult, { ok: false, depth_exceeded: { parent_depth: 1, max_depth: 1 } });
  assert.equal(gatedWritten.size, 0, "pasiekus ribą negimsta nė vienas vaikas");

  const invalidResult = await enqueueChildTasks(ports, "/ag", "0042", {
    child_tasks: [
      { title: "geras", claude_task: VALID_CHILD },
      { title: "blogas", claude_task: "## Tikslas\nbe antraščių\n" },
    ],
  });
  assert.equal(invalidResult.ok, false);
  assert.deepEqual((invalidResult as { invalid: { title: string }[] }).invalid.map((c) => c.title), ["blogas"]);
  assert.equal(written.size, 0, "su nevalidžiu vaiku nerašomas nė vienas");
});

test("enqueueChildTasks: idempotencija per turinio parašą, spec source paveldėjimas", async () => {
  const { ports, ledger, written, logs } = makeEnqueuePorts();
  const decision = {
    claude_task: "# Task\n## Spec source\nopenspec/changes/parent\n## Tikslas\nTėvas.\n",
    child_tasks: [{ title: "vaikas", claude_task: "# Task\n## Tikslas\nVaikas.\n## Veiksmas\n- d\n## Stop\nS.\n" }],
  };
  const first = await enqueueChildTasks(ports, "/ag", "0042", decision);
  assert.deepEqual(first, { ok: true, enqueued: 1 });
  assert.equal(written.size, 1);
  const [file, content] = [...written.entries()][0]!;
  assert.match(file, /0042-a-02-vaikas/);
  assert.match(content, /## Spec source\nopenspec\/changes\/parent/, "spec source paveldėtas iš tėvo");
  assert.equal(ledger.get("0042#2")?.depth, 1);
  assert.ok(logs.some((line) => line.includes("TASK SPLIT: parent=0042 queued_child_tasks=1")));

  const second = await enqueueChildTasks(ports, "/ag", "0042", decision);
  assert.deepEqual(second, { ok: true, enqueued: 1 });
  assert.equal(written.size, 1, "nepakitęs turinys nerašomas antrą kartą");
  assert.equal(contentSignature("a", "b"), contentSignature("a", "b"), "parašas deterministinis");
});

const GRAPH_TASK = `# Task
## Spec source
openspec/changes/demo
## Tikslas
Rotate jwt secrets.
## Dependencies
- blocked_by: 0001
## Failai
Leidžiama:
- \`src/auth/token.ts\`
## Veiksmas
- daryk
## Patikra
- \`pnpm test\`
## Stop
S.
`;

test("taskNodeFromMarkdown: kanoniniai parseriai ir approval taisyklės", () => {
  const node = taskNodeFromMarkdown(GRAPH_TASK, "AG/tasks/queue/0042.md", "queue");
  assert.equal(node.task_id, "0042");
  assert.deepEqual(node.depends_on, ["0001"]);
  assert.deepEqual(node.checks, ["pnpm test"]);
  assert.deepEqual(node.scope, ["src/auth/token.ts"]);
  assert.equal(node.requires_approval, true, "security gate iš turinio");
  assert.equal(node.approved, false);

  const parked = taskNodeFromMarkdown("# Task\n## Tikslas\nDocs.\n", "AG/tasks/human-review/0001.md", "human-review");
  assert.equal(parked.requires_approval, true, "human-review bucket'e laukiama žmogaus");
});

test("importTaskGraphFromMarkdown + routeBlockedTasksToHumanReview per fake portus", async () => {
  const buckets = new Map<TaskBucket, BucketTaskFile[]>([
    ["queue", [
      { file: "AG/tasks/queue/0042.md", text: GRAPH_TASK },
      { file: "AG/tasks/queue/0050.md", text: "# Task\n## Tikslas\nLaisvas.\n" },
    ]],
    ["done", [{ file: "AG/tasks/done/0001.md", text: "# Task\n## Tikslas\nBlocker.\n" }]],
  ]);
  const listPorts = { listTasksInBucket: async (bucket: TaskBucket) => buckets.get(bucket) ?? [] };

  const graph = await importTaskGraphFromMarkdown(listPorts);
  assert.equal(graph.nodes.length, 3);

  const writes: [string, string][] = [];
  const moves: string[] = [];
  const routePorts = {
    ...listPorts,
    readTaskText: async (file: string) => buckets.get("queue")!.find((task) => task.file === file)!.text,
    writeTaskText: async (file: string, text: string) => void writes.push([file, text]),
    moveToHumanReview: async (file: string) => file.replace("/queue/", "/human-review/"),
  };
  const result = await routeBlockedTasksToHumanReview(routePorts, "0001");
  assert.equal(result.scanned, 2);
  assert.equal(result.routed.length, 1);
  assert.deepEqual(result.routed[0], {
    task_id: "0042",
    from: "AG/tasks/queue/0042.md",
    to: "AG/tasks/human-review/0042.md",
    blocked_by: "0001",
  });
  assert.match(writes[0]![1], /Human review block/i, "užrašomas blokavimo notice");
});

test("carryTaskScopeIntoRepairPrompt: perkelia Failai/Patikra/Spec source; idempotentiškas", () => {
  const original = "# Task\n## Spec source\nopenspec/x\n## Failai\nLeidžiama:\n- `src/a.ts`\n## Patikra\n- `pnpm test`\n";
  const repair = "# Repair Task\n## Klaida\nlūžo\n## Veiksmas\n- taisyk\n";
  const carried = carryTaskScopeIntoRepairPrompt(repair, original);
  assert.match(carried, /## Failai\nLeidžiama:\n- `src\/a\.ts`/);
  assert.match(carried, /## Patikra\n- `pnpm test`/);
  assert.match(carried, /## Spec source\nopenspec\/x/);
  assert.equal(carryTaskScopeIntoRepairPrompt(carried, carried), carried, "antras ratas — no-op");
  assert.equal(carryTaskScopeIntoRepairPrompt("  ", original), "  ", "tuščias prompt'as nepildomas");
});

test("taskRepairPath: kelias vq/state/repair ir traversal saugiklis", () => {
  assert.match(taskRepairPath("/repo/vq", "0042"), /state[\\/]repair[\\/]0042\.md$/);
  assert.throws(() => taskRepairPath("/repo/vq", "../evil"), /Invalid repair task id/);
  assert.throws(() => taskRepairPath("/repo/vq", ".."), /Invalid repair task id/);
});

test("taskLedgerEntrySeenBefore: būsenų aibė, fingerprint išimtis, failed normalizacija", () => {
  assert.equal(taskLedgerEntrySeenBefore(undefined), false);
  assert.equal(taskLedgerEntrySeenBefore({ state: "queue" }), false, "queue nėra seen būsena");
  assert.equal(taskLedgerEntrySeenBefore({ state: "done" }), true);
  assert.equal(taskLedgerEntrySeenBefore({ state: "failed" }), true, "failed normalizuojasi į human-review");
  assert.equal(normalizeTaskLedgerState("failed"), "human-review");
  // Pakitęs turinys = teisėtas re-run, ne duplikatas.
  assert.equal(taskLedgerEntrySeenBefore({ state: "done", fingerprint: "senas" }, "naujas"), false);
  assert.equal(taskLedgerEntrySeenBefore({ state: "done", fingerprint: "tas" }, "tas"), true);
  assert.equal(taskLedgerEntrySeenBefore({ state: "done" }, "naujas"), true, "be įrašo fingerprint'o — name-only");
});

test("task-events kontraktas: tailChars kerpa iš galo, phaseFailureReason forma stabili", () => {
  assert.equal(tailChars("trumpas\n"), "trumpas");
  const long = "x".repeat(3000);
  const tail = tailChars(long, 100);
  assert.ok(tail.startsWith("...\n"));
  assert.equal(tail.length, 104);
  assert.equal(phaseFailureReason("preflight", 2), "preflight_failed=2");
});

test("parseSpecTaskLines: checkbox unija, evidence anotacijos ir kabučių valymas", () => {
  const md = [
    "- [x] Padaryta užduotis.",
    "- [ ] Laukianti `užduotis`.",
    "* Bullet be checkbox",
    "- Užbaigta anksčiau. (2026-07-01, task 823: commit abc)",
    "",
    "ne bullet eilutė",
  ].join("\n");
  const all = parseSpecTaskLines(md);
  assert.deepEqual(all.map((task) => [task.title, task.complete]), [
    ["Padaryta užduotis", true],
    ["Laukianti užduotis", false],
    ["Bullet be checkbox", false],
    ["Užbaigta anksčiau", false],
  ]);
  assert.deepEqual(all.map((task) => task.index), [1, 2, 3, 4]);

  const checkboxOnly = parseSpecTaskLines(md, { requireCheckbox: true });
  assert.deepEqual(checkboxOnly.map((task) => task.title), ["Padaryta užduotis", "Laukianti užduotis"]);
});
