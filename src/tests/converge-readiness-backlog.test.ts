// Converge / readiness / backlog patikrų testai (VQ-305 3/3-g). Elgesio etalonas: AG_loop
// converge/readiness/backlog testų branduolys, sutrauktas iki portų lygio.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  auditBacklog,
  auditTaskStates,
  renderBacklogAudit,
  type BacklogAuditPorts,
  type BacklogCategory,
} from "../application/release-readiness/backlog-audit.js";
import { converge, type ConvergePorts } from "../application/release-readiness/converge-check.js";
import {
  parseReadmeMainCommands,
  parseRegisteredCommands,
  runReadinessAudit,
  type ReadinessPorts,
  type ReadinessRequirements,
} from "../application/release-readiness/readiness-audit.js";

const ROOT = path.resolve("/repo");
const abs = (rel: string): string => path.join(ROOT, rel).replace(/\\/g, "/");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const norm = (p: string): string => p.replace(/\\/g, "/");

type Fixture = {
  files: Map<string, string>;
  mtimes: Map<string, number>;
};

function convergePorts(fixture: Fixture): ConvergePorts {
  const dirsOf = (dir: string, kind: "file" | "dir"): string[] => {
    const prefix = norm(dir).endsWith("/") ? norm(dir) : `${norm(dir)}/`;
    const names = new Set<string>();
    for (const key of fixture.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const first = rest.split("/")[0]!;
      const isDir = rest.includes("/");
      if ((kind === "dir") === isDir) names.add(first);
    }
    return [...names];
  };
  return {
    readTextFileIfExists: async (p) => fixture.files.get(norm(p)),
    listSubdirectories: async (dir) => dirsOf(dir, "dir"),
    listFiles: async (dir) => dirsOf(dir, "file"),
    fileMtimeMs: async (p) => fixture.mtimes.get(norm(p)),
  };
}

test("converge: trūkstamas suplanuotas task'as, nebaigtas darbas ir pasenęs status — trys issue rūšys", async () => {
  const fixture: Fixture = {
    files: new Map([
      [abs("AG/openspec/changes/my-change/tasks.md"), "- [ ] Pirmas darbas queue 001\n- [x] Baigtas darbas\n"],
      [abs("AG/tasks/human-review/044-stuck.md"), "# Task\n"],
    ]),
    mtimes: new Map([[abs("AG/openspec/changes/my-change/tasks.md"), 2000]]),
  };
  const result = await converge(convergePorts(fixture), { projectRoot: "/repo", runtimeRoot: RUNTIME_ROOT });
  assert.equal(result.status, "issues");
  assert.equal(result.active_spec, "AG/openspec:my-change");
  assert.deepEqual(
    result.issues.map((issue) => issue.kind),
    ["incomplete-work", "missing-task", "stale-status", "stale-status"],
  );
  assert.ok(result.issues.some((issue) => issue.ref === "human-review/044-stuck.md"));
});

test("converge: queueId atitikmuo eilėje, tušti nebaigti bucket'ai ir švieži status failai konverguoja", async () => {
  const tasksMd = abs("AG/openspec/changes/my-change/tasks.md");
  const fixture: Fixture = {
    files: new Map([
      [tasksMd, "- [ ] Pirmas darbas queue 001\n"],
      [abs("AG/tasks/queue/001-pirmas-darbas.md"), "# Task\n"],
      [abs("vq/project/status.md"), "status"],
      [abs("vq/project/next-tasks.md"), "next"],
    ]),
    mtimes: new Map([
      [tasksMd, 1000],
      [abs("vq/project/status.md"), 2000],
      [abs("vq/project/next-tasks.md"), 2000],
    ]),
  };
  const result = await converge(convergePorts(fixture), { projectRoot: "/repo", runtimeRoot: RUNTIME_ROOT });
  assert.deepEqual(result.issues, []);
  assert.equal(result.status, "converged");
});

test("readiness: trūkstamas konfigas ir nedokumentuota komanda krenta į savo kategorijas", async () => {
  const files = new Map<string, string>([
    [abs("README.md"), "# X\n\n## Main Commands\n- `verqestra run`\n- `pnpm verqestra status`\n\n## Kita\n"],
    [abs("src/cli.ts"), 'register({ name: "run" });\nregister({ name: "extra" });'],
    [abs("docs/getting-started.md"), "turinys"],
  ]);
  const dirs = new Set([abs("src"), abs("AG/tasks/queue")]);
  const ports: ReadinessPorts = {
    statKind: async (p) => (files.has(norm(p)) ? "file" : dirs.has(norm(p)) ? "directory" : "absent"),
    readTextFileIfExists: async (p) => files.get(norm(p)),
  };
  const requirements: ReadinessRequirements = {
    folders: ["src", "AG/tasks/queue"],
    configs: ["vq/config/quality-policy.json"],
    tests: [],
    docs: ["docs/getting-started.md"],
    commandSources: ["src/cli.ts"],
  };
  const result = await runReadinessAudit(ports, "/repo", requirements);
  assert.equal(result.status, "not_ready");
  assert.deepEqual(result.categories.configs.missing, ["vq/config/quality-policy.json"]);
  assert.deepEqual(result.categories.commands.missing, ["implementation:status", "documentation:extra"]);
  assert.deepEqual(result.missing_areas, ["configs", "commands"]);
  assert.deepEqual(parseReadmeMainCommands("be sekcijos"), []);
  assert.deepEqual(parseRegisteredCommands(['{ name: "b" }', '{name: "a"}']), ["a", "b"]);
});

test("backlog: split-vaikai ir done/ archyvas nekelia dublikatų, tvarka ir kategorijos tikrinamos", () => {
  const categories: readonly BacklogCategory[] = [
    { id: "core", label: "Core", keywords: ["core"] },
    { id: "ui", label: "UI", keywords: ["dashboard"] },
  ];
  const result = auditBacklog(
    [
      { file: "queue/012-parent.md", number: 12, goal: "core loop" },
      { file: "queue/012-parent-02-sub.md", number: 12, goal: "core child" },
      { file: "done/013-old.md", number: 13, goal: "core done" },
      { file: "done/013-old-2.md", number: 13, goal: "core done again" },
      { file: "queue/015-later.md", number: 15, goal: "core later" },
      { file: "queue/014-out-of-order.md", number: 14, goal: "core misplaced" },
    ],
    categories,
  );
  assert.deepEqual(result.duplicate_numbers, []);
  assert.equal(result.out_of_order.length, 1);
  assert.equal(result.out_of_order[0]?.file, "queue/014-out-of-order.md");
  assert.deepEqual(result.missing_categories, ["ui"]);
  assert.equal(result.status, "incomplete");
  assert.match(renderBacklogAudit(result), /Missing categories: ui/);
});

test("auditTaskStates: skaito visus bucket'us per portą ir pažymi realią numerio koliziją", async () => {
  const files = new Map<string, string>([
    [abs("AG/tasks/queue/021-first.md"), "# Task\n\n## Tikslas\ncore darbas\n"],
    [abs("AG/tasks/error/021-second-unrelated.md"), "# Task\n\n## Tikslas\nkitas core darbas\n"],
  ]);
  const ports: BacklogAuditPorts = {
    listFiles: async (dir) => {
      const prefix = `${norm(dir)}/`;
      return [...files.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
    },
    readTextFileIfExists: async (p) => files.get(norm(p)),
  };
  const result = await auditTaskStates(ports, path.join(ROOT, "AG", "tasks"));
  assert.equal(result.task_count, 2);
  assert.deepEqual(result.duplicate_numbers, [21]);
});
