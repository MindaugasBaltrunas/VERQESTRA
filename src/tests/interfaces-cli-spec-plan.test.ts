// VQ-501 (3/5-b) testai — plan ir openspec-reconcile per fake portus: plan
// created/validated/overwritten/klaidų keliai + architektūros kontrakto loader'io
// klaidos; reconcile gyvas archyvavimas (tasks.md PIRMA, rename PO TO), idempotencija,
// dry-run be rašymų, --json ataskaita, ambiguous ir pilnai suderintas exit 0.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { loadArchitectureContract } from "../application/policy-governance/architecture-contract.js";
import type { PlanPorts } from "../application/task-planning/plan.js";
import type { TaskPlanningFsPort } from "../application/task-planning/spec-source.js";
import type {
  OpenSpecReconcileFsPort,
  OpenSpecReconcileReport,
} from "../application/task-execution/openspec-reconcile.js";
import type { CliIo } from "../interfaces/cli/registry.js";
import { planCommand } from "../interfaces/cli/spec/plan.js";
import { openSpecReconcileCommand } from "../interfaces/cli/spec/openspec-reconcile.js";

const ROOT = path.resolve("/repo");
const AG_ROOT = path.join(ROOT, "AG");
const norm = (p: string): string => p.replace(/\\/g, "/");

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

function makePlanPorts(
  files: Map<string, string>,
  dirs: Map<string, string[]>,
): { ports: PlanPorts; writeCount: () => number } {
  let writes = 0;
  const fs: TaskPlanningFsPort = {
    exists: async (p) => files.has(norm(p)),
    readTextFileIfExists: async (p) => files.get(norm(p)),
    listSubdirectories: async (d) => dirs.get(norm(d)) ?? [],
  };
  return {
    ports: {
      fs,
      writeTextFile: async (p, text) => {
        writes += 1;
        files.set(norm(p), text);
      },
    },
    writeCount: () => writes,
  };
}

const CONTRACT_PATH = path.join(ROOT, "vq", "project", "architecture-contract.json");

function planFixture(): { files: Map<string, string>; dirs: Map<string, string[]> } {
  const changeDir = path.join(ROOT, "AG", "spec", "changes", "001-x");
  const files = new Map<string, string>([[norm(path.join(changeDir, "spec.json")), JSON.stringify({ id: "spec-001", status: "active" })]]);
  for (const name of ["proposal.md", "requirements.md", "design.md", "tasks.md", "acceptance.md", "risks.md"]) {
    files.set(norm(path.join(changeDir, name)), "turinys");
  }
  const dirs = new Map<string, string[]>([[norm(path.join(ROOT, "AG", "spec", "changes")), ["001-x"]]]);
  return { files, dirs };
}

test("planCommand: pirmas paleidimas sukuria kontraktą (state: created)", async () => {
  const { io, out } = captureIo();
  const { files, dirs } = planFixture();
  const { ports, writeCount } = makePlanPorts(files, dirs);
  const exit = await planCommand({ ports, projectRoot: ROOT, io }, []);
  assert.equal(exit, 0);
  assert.deepEqual(out, [
    "AG plan ready: spec-001",
    `architecture contract: ${path.relative(ROOT, CONTRACT_PATH)}`,
    "state: created",
  ]);
  assert.equal(writeCount(), 1);
  const written = files.get(norm(CONTRACT_PATH));
  assert.ok(written);
  const contract = JSON.parse(written) as { generated_from: string; checks: string[] };
  assert.equal(contract.generated_from, "AG/spec/changes/001-x/spec.json");
  assert.deepEqual(contract.checks, ["pnpm build", "pnpm test"]);
});

test("planCommand: esamas kontraktas be --force — validated, be rašymo", async () => {
  const { io, out } = captureIo();
  const { files, dirs } = planFixture();
  const { ports, writeCount } = makePlanPorts(files, dirs);
  assert.equal(await planCommand({ ports, projectRoot: ROOT, io }, []), 0);
  const { io: io2, out: out2 } = captureIo();
  assert.equal(await planCommand({ ports, projectRoot: ROOT, io: io2 }, []), 0);
  assert.equal(out2[2], "state: validated");
  assert.equal(writeCount(), 1);
  assert.equal(out[2], "state: created");
});

test("planCommand: --force perrašo (state: overwritten)", async () => {
  const { io } = captureIo();
  const { files, dirs } = planFixture();
  const { ports, writeCount } = makePlanPorts(files, dirs);
  assert.equal(await planCommand({ ports, projectRoot: ROOT, io }, []), 0);
  const { io: io2, out: out2 } = captureIo();
  assert.equal(await planCommand({ ports, projectRoot: ROOT, io: io2 }, ["--force"]), 0);
  assert.equal(out2[2], "state: overwritten");
  assert.equal(writeCount(), 2);
});

test("planCommand: trūkstamas/tuščias spec failas — klaida ir exit 2", async () => {
  const { io, err } = captureIo();
  const { files, dirs } = planFixture();
  files.set(norm(path.join(ROOT, "AG", "spec", "changes", "001-x", "risks.md")), "   ");
  const { ports } = makePlanPorts(files, dirs);
  const exit = await planCommand({ ports, projectRoot: ROOT, io }, []);
  assert.equal(exit, 2);
  assert.match(err[0] ?? "", /^Required spec files missing or empty: /);
  assert.match(err[0] ?? "", /risks\.md/);
});

test("planCommand: sugadintas esamas kontraktas — is not valid JSON ir exit 2", async () => {
  const { io, err } = captureIo();
  const { files, dirs } = planFixture();
  files.set(norm(CONTRACT_PATH), "not-json");
  const { ports } = makePlanPorts(files, dirs);
  const exit = await planCommand({ ports, projectRoot: ROOT, io }, []);
  assert.equal(exit, 2);
  assert.match(err[0] ?? "", /is not valid JSON/);
});

test("loadArchitectureContract: trūkstamas failas — not found klaida", async () => {
  await assert.rejects(
    loadArchitectureContract({ readTextFileIfExists: async () => undefined }, "/x/contract.json"),
    /not found/,
  );
});

// ---------------------------------------------------------------------------
// openspec-reconcile
// ---------------------------------------------------------------------------

type FakeWorld = { files: Map<string, string>; dirs: Set<string> };

function makeReconcileFs(world: FakeWorld): OpenSpecReconcileFsPort {
  const parentOf = (p: string): string => norm(path.dirname(p));
  return {
    exists: async (p) => world.files.has(norm(p)) || world.dirs.has(norm(p)),
    readTextFileIfExists: async (p) => world.files.get(norm(p)),
    writeTextFileAtomic: async (p, content) => {
      world.files.set(norm(p), content);
    },
    makeDirectory: async (d) => {
      world.dirs.add(norm(d));
    },
    rename: async (from, to) => {
      const source = norm(from);
      const target = norm(to);
      if (world.dirs.has(source)) {
        world.dirs.delete(source);
        world.dirs.add(target);
      }
      for (const key of [...world.files.keys()]) {
        if (key === source || key.startsWith(`${source}/`)) {
          const value = world.files.get(key)!;
          world.files.delete(key);
          world.files.set(target + key.slice(source.length), value);
        }
      }
    },
    listSubdirectories: async (d) => {
      const dir = norm(d);
      return [...world.dirs].filter((entry) => parentOf(entry) === dir).map((entry) => path.basename(entry)).sort();
    },
    listFiles: async (d) => {
      const dir = norm(d);
      return [...world.files.keys()].filter((entry) => parentOf(entry) === dir).map((entry) => path.basename(entry)).sort();
    },
  };
}

const changeAbs = (rel: string): string => norm(path.join(AG_ROOT, "openspec", "changes", rel));

function reconcileWorld(): FakeWorld {
  const files = new Map<string, string>();
  const dirs = new Set<string>([changeAbs("auto-0042-fix"), changeAbs("auto-0099-orphan"), changeAbs("named-change")]);
  files.set(norm(path.join(changeAbs("auto-0042-fix"), "tasks.md")), "- [ ] a\n- [x] b\n");
  files.set(norm(path.join(changeAbs("named-change"), "tasks.md")), "- [ ] open\n");
  files.set(norm(path.join(AG_ROOT, "tasks", "done", "0042.md")), "žr. openspec/changes/auto-0042-fix");
  files.set(norm(path.join(AG_ROOT, "tasks", "done", "0007.md")), "jokios nuorodos");
  return { files, dirs };
}

test("openSpecReconcileCommand: --apply archyvuoja (tasks.md pirma) ir grąžina 1 dėl likučio", async () => {
  const { io, out } = captureIo();
  const world = reconcileWorld();
  const exit = await openSpecReconcileCommand({ fs: makeReconcileFs(world), agRoot: AG_ROOT, io }, ["--apply"]);
  assert.equal(exit, 1);
  assert.deepEqual(out, [
    "openspec-reconcile: partial (2 done tasks scanned)",
    "archived: 1 of 2 active auto changes",
    "  archived: openspec/changes/auto-0042-fix <- 0042",
    "  no done task: openspec/changes/auto-0099-orphan",
    "  human-owned, 1 open item(s): openspec/changes/named-change",
  ]);
  assert.ok(!world.dirs.has(changeAbs("auto-0042-fix")));
  assert.ok(world.dirs.has(changeAbs("archive/auto-0042-fix")));
  assert.equal(world.files.get(norm(path.join(changeAbs("archive/auto-0042-fix"), "tasks.md"))), "- [x] a\n- [x] b\n");
});

test("openSpecReconcileCommand: antras --apply paleidimas idempotentiškas (already-archived, nieko nerašo)", async () => {
  const world = reconcileWorld();
  const fs = makeReconcileFs(world);
  assert.equal(await openSpecReconcileCommand({ fs, agRoot: AG_ROOT, io: captureIo().io }, ["--apply"]), 1);
  const { io, out } = captureIo();
  const exit = await openSpecReconcileCommand({ fs, agRoot: AG_ROOT, io }, ["--apply", "--json"]);
  assert.equal(exit, 1);
  const report = JSON.parse(out.join("\n")) as OpenSpecReconcileReport;
  assert.equal(report.archived.length, 0);
  assert.deepEqual(report.already_archived, ["openspec/changes/auto-0042-fix"]);
  assert.deepEqual(report.unmatched_auto_changes, ["openspec/changes/auto-0099-orphan"]);
});

test("openSpecReconcileCommand: numatytasis režimas (be --apply) nieko nerašo ir spausdina would archive", async () => {
  const { io, out } = captureIo();
  const world = reconcileWorld();
  const exit = await openSpecReconcileCommand({ fs: makeReconcileFs(world), agRoot: AG_ROOT, io }, []);
  assert.equal(exit, 1);
  assert.equal(out[1], "dry run — re-run with --apply to archive");
  assert.equal(out[2], "would archive: 1 of 2 active auto changes");
  assert.equal(out[3], "  would archive: openspec/changes/auto-0042-fix <- 0042");
  assert.ok(world.dirs.has(changeAbs("auto-0042-fix")));
  assert.equal(world.files.get(norm(path.join(changeAbs("auto-0042-fix"), "tasks.md"))), "- [ ] a\n- [x] b\n");
});

test("openSpecReconcileCommand: --dry-run yra numatytosios elgsenos sinonimas", async () => {
  const { io, out } = captureIo();
  const world = reconcileWorld();
  const exit = await openSpecReconcileCommand({ fs: makeReconcileFs(world), agRoot: AG_ROOT, io }, ["--dry-run"]);
  assert.equal(exit, 1);
  assert.equal(out[1], "dry run — re-run with --apply to archive");
  assert.equal(out[2], "would archive: 1 of 2 active auto changes");
  assert.ok(world.dirs.has(changeAbs("auto-0042-fix")));
});

test("openSpecReconcileCommand: --apply su --dry-run — usage klaida, exit 2", async () => {
  const { io, err } = captureIo();
  const world = reconcileWorld();
  const exit = await openSpecReconcileCommand({ fs: makeReconcileFs(world), agRoot: AG_ROOT, io }, ["--apply", "--dry-run"]);
  assert.equal(exit, 2);
  assert.match(err[0] ?? "", /--apply and --dry-run are mutually exclusive/);
  assert.ok(world.dirs.has(changeAbs("auto-0042-fix")));
});

test("openSpecReconcileCommand: --json ataskaita su marked_task_lines (--apply)", async () => {
  const { io, out } = captureIo();
  const world = reconcileWorld();
  const exit = await openSpecReconcileCommand({ fs: makeReconcileFs(world), agRoot: AG_ROOT, io }, ["--apply", "--json"]);
  assert.equal(exit, 1);
  const report = JSON.parse(out.join("\n")) as OpenSpecReconcileReport;
  assert.equal(report.status, "partial");
  assert.equal(report.dry_run, false);
  assert.equal(report.scanned_done_tasks, 2);
  assert.equal(report.active_auto_changes_before, 2);
  assert.deepEqual(report.archived, [
    { change: "openspec/changes/auto-0042-fix", task: "0042", marked_task_lines: 1 },
  ]);
  assert.deepEqual(report.named_changes_open, [{ change: "openspec/changes/named-change", open_items: 1 }]);
});

test("openSpecReconcileCommand: --json ataskaita be --apply (dry_run: true)", async () => {
  const { io, out } = captureIo();
  const world = reconcileWorld();
  const exit = await openSpecReconcileCommand({ fs: makeReconcileFs(world), agRoot: AG_ROOT, io }, ["--json"]);
  assert.equal(exit, 1);
  const report = JSON.parse(out.join("\n")) as OpenSpecReconcileReport;
  assert.equal(report.dry_run, true);
  assert.equal(report.scanned_done_tasks, 2);
  assert.equal(report.active_auto_changes_before, 2);
});

test("openSpecReconcileCommand: pilnai suderinta — exit 0", async () => {
  const { io, out } = captureIo();
  const world: FakeWorld = { files: new Map(), dirs: new Set([changeAbs("auto-0042-fix")]) };
  world.files.set(norm(path.join(AG_ROOT, "tasks", "done", "0042.md")), "žr. openspec/changes/auto-0042-fix");
  const exit = await openSpecReconcileCommand({ fs: makeReconcileFs(world), agRoot: AG_ROOT, io }, ["--apply"]);
  assert.equal(exit, 0);
  assert.equal(out[0], "openspec-reconcile: reconciled (1 done tasks scanned)");
});

test("openSpecReconcileCommand: dvi nuorodos — ambiguous eina operatoriui", async () => {
  const { io, out } = captureIo();
  const world: FakeWorld = { files: new Map(), dirs: new Set([changeAbs("auto-a")]) };
  world.files.set(
    norm(path.join(AG_ROOT, "tasks", "done", "0042.md")),
    "openspec/changes/auto-a ir openspec/changes/auto-b",
  );
  const exit = await openSpecReconcileCommand({ fs: makeReconcileFs(world), agRoot: AG_ROOT, io }, ["--apply"]);
  assert.equal(exit, 1);
  assert.ok(out.includes("  needs operator: 0042 — ambiguous"));
  assert.ok(out.includes("  no done task: openspec/changes/auto-a"));
});
