// VQ-304 (1 dalis): task-execution grynųjų taisyklių unit testai — retry/infra dispozicijos,
// cheap-finish prompt sudėjimas, skip-dispatch sprendimas, adapterio routing, openspec
// archyvavimo tekstinės taisyklės ir preflight memo schema. Jokio IO.
import assert from "node:assert/strict";
import test from "node:test";
import {
  composeCheapFinishPrompt,
  infrastructureFailureDisposition,
  looksLikeRepairDispatchPrompt,
  preflightRetryWithoutChange,
  PREFLIGHT_START_FAILURE_CLASS,
} from "../application/task-execution/run-coordinator-guards.js";
import {
  preflightFailureMemoRecordSchema,
  PREFLIGHT_FAILURE_MEMO_SCHEMA_VERSION,
  type PreflightFailureMemoRecord,
} from "../application/quality-gates/preflight-memo-schema.js";
import { resolveSkipDispatch } from "../application/task-execution/skip-dispatch.js";
import { resolveDispatchAdapter, resolveLoopDispatchAdapter } from "../application/task-execution/adapter-routing.js";
import { taskFileBasename } from "../application/task-execution/task-run-state.js";
import { extractAutoChangeSlugs, markTasksComplete } from "../application/task-execution/openspec-archive.js";
import { slugFromTask } from "../application/task-planning/openspec-slug.js";
import { taskBucketDir, finishTaskInBucket, type TaskStateStorePort } from "../application/task-execution/bucket-transition.js";
import type { AgentPolicy } from "../domain/policies/agent-selection.js";

const memoRecord: PreflightFailureMemoRecord = {
  schema_version: PREFLIGHT_FAILURE_MEMO_SCHEMA_VERSION,
  task_id: "0042",
  content_hash: "abc123",
  failure_class: "preflight-exit",
  exit_code: 1,
  failed_at: "2026-08-20T00:00:00Z",
  repeat_count: 1,
};

test("infrastructureFailureDisposition: preserve tik error bucket'e su repair prompt'u", () => {
  assert.equal(infrastructureFailureDisposition("error", true), "preserve");
  assert.equal(infrastructureFailureDisposition("error", false), "requeue");
  assert.equal(infrastructureFailureDisposition("active", true), "requeue");
  assert.equal(infrastructureFailureDisposition("delegated", false), "requeue");
});

test("preflightRetryWithoutChange: hit tik ant to paties task/hash/klasės", () => {
  const expected = { taskId: "0042", contentHash: "abc123", failureClass: PREFLIGHT_START_FAILURE_CLASS };
  assert.equal(preflightRetryWithoutChange(memoRecord, expected), true);
  assert.equal(preflightRetryWithoutChange(undefined, expected), false, "be įrašo — ne hit");
  assert.equal(
    preflightRetryWithoutChange(memoRecord, { ...expected, contentHash: "" }),
    false,
    "tuščias hash niekada nelaikomas sutapimu",
  );
  assert.equal(preflightRetryWithoutChange(memoRecord, { ...expected, contentHash: "kitas" }), false);
  assert.equal(preflightRetryWithoutChange(memoRecord, { ...expected, taskId: "0001" }), false);
});

test("preflight memo schema: strict — nežinomas laukas ar klasė atmetami", () => {
  assert.equal(preflightFailureMemoRecordSchema.safeParse(memoRecord).success, true);
  assert.equal(
    preflightFailureMemoRecordSchema.safeParse({ ...memoRecord, extra: 1 }).success,
    false,
    "nepažįstamas laukas privalo reikšti: įrašo nėra",
  );
  assert.equal(preflightFailureMemoRecordSchema.safeParse({ ...memoRecord, failure_class: "kita" }).success, false);
  assert.equal(preflightFailureMemoRecordSchema.safeParse({ ...memoRecord, repeat_count: 0 }).success, false);
});

test("cheap finish prompt: repair antraštės nužeminamos (įsk. CRLF), signalas įterpiamas", () => {
  const prompt = composeCheapFinishPrompt({
    taskBody: "# Task\n## Tikslas\nDaryk X.",
    signal: "typecheck: TS2322 src/x.ts:10",
    repairContext: "# Repair Task\r\nKontekstas apie klaidą.",
  });
  assert.equal(looksLikeRepairDispatchPrompt(prompt), false, "prompt'e neturi likti # Repair Task antraštės");
  assert.match(prompt, /## Cheap finish/);
  assert.match(prompt, /typecheck: TS2322/);
  assert.match(prompt, /### Repair Task \(kontekstas\)/);
  assert.match(prompt, /^# Task/m, "originalus kūnas perkeliamas nepakeistas");
});

test("cheap finish prompt be repair konteksto: bloko nėra", () => {
  const prompt = composeCheapFinishPrompt({ taskBody: "# Task\nX", signal: "test failed" });
  assert.doesNotMatch(prompt, /Repair kontekstas:/);
});

test("looksLikeRepairDispatchPrompt: atpažįsta CRLF eilutę", () => {
  assert.equal(looksLikeRepairDispatchPrompt("intro\n# Repair Task\r\nbody"), true);
  assert.equal(looksLikeRepairDispatchPrompt("### Repair Task (kontekstas)"), false);
});

test("resolveSkipDispatch: griežtėjimo tvarka — repo, įrodymas, švarus medis", () => {
  assert.deepEqual(resolveSkipDispatch({ isRepository: false }), { kind: "dispatch", reason: "not-a-git-repository" });
  assert.deepEqual(resolveSkipDispatch({ isRepository: true }), { kind: "dispatch", reason: "no-work-evidence" });
  assert.deepEqual(resolveSkipDispatch({ isRepository: true, workEvidenceCommit: "  " }), {
    kind: "dispatch",
    reason: "no-work-evidence",
  });
  assert.deepEqual(resolveSkipDispatch({ isRepository: true, workEvidenceCommit: "abc", productDirtyCount: 2 }), {
    kind: "dispatch",
    reason: "dirty-tree",
  });
  assert.deepEqual(resolveSkipDispatch({ isRepository: true, workEvidenceCommit: "abc", productDirtyCount: 0 }), {
    kind: "skip",
    commit: "abc",
  });
});

const policy: AgentPolicy = {
  version: "1",
  default_role: "coder",
  roles: {
    coder: { allowed_adapters: ["claude"], default_model_hint: "sonnet", can_write_code: true },
    tester: { allowed_adapters: ["codex", "claude"], default_model_hint: "sonnet", can_write_code: true },
    "dry-only": { allowed_adapters: ["dry-run"], default_model_hint: "haiku", can_write_code: false },
  },
};

const taskWithRole = (role: string): string => `# Task\n## Agentai\nprimary: ${role}\n`;

test("resolveDispatchAdapter: auto ima pirmą leidžiamą; nežinomas adapteris meta", () => {
  const decision = resolveDispatchAdapter(taskWithRole("tester"), policy, "auto");
  assert.equal(decision.adapter, "codex");
  assert.equal(decision.role, "tester");
  assert.throws(() => resolveDispatchAdapter(taskWithRole("coder"), policy, "banana"), /Unknown execution adapter/);
});

test("resolveDispatchAdapter: ne-dry-run adapteris prieš rolės sąrašą; dry-run visada leidžiamas", () => {
  assert.throws(() => resolveDispatchAdapter(taskWithRole("coder"), policy, "codex"), /neleistinas vaidmeniui/);
  assert.equal(resolveDispatchAdapter(taskWithRole("coder"), policy, "dry-run").adapter, "dry-run");
  // Be `## Agentai` bloko rolės vartai netaikomi.
  assert.equal(resolveDispatchAdapter("# Task\nlaisvas tekstas", policy, "codex").adapter, "codex");
});

test("resolveLoopDispatchAdapter: loop'as fiksuoja claude; draudžianti rolė meta", () => {
  assert.equal(resolveLoopDispatchAdapter(taskWithRole("coder"), policy).adapter, "claude");
  assert.throws(() => resolveLoopDispatchAdapter(taskWithRole("dry-only"), policy), /neleistinas vaidmeniui/);
});

test("taskFileBasename: veikia su / ir \\ be node:path", () => {
  assert.equal(taskFileBasename("/ag/tasks/queue/0042.md"), "0042.md");
  assert.equal(taskFileBasename("D:\\repo\\AG\\tasks\\active\\0042.md"), "0042.md");
  assert.equal(taskFileBasename("0042.md"), "0042.md");
  assert.equal(taskFileBasename("/dir/su/uodega///"), "uodega");
});

test("extractAutoChangeSlugs: tik auto-, be archive/_template, taškas nukerpamas, dedup", () => {
  const text = [
    "žr. openspec/changes/auto-0042-fix.",
    "AG/openspec/changes/auto-0042-fix/spec.md",
    "openspec/changes/rankinis-change",
    "openspec/changes/archive/auto-senas",
    "openspec/changes/_template",
  ].join("\n");
  assert.deepEqual(extractAutoChangeSlugs(text), ["auto-0042-fix"]);
});

test("markTasksComplete: žymi checklist'ą, praleidžia fenced blokus, išsaugo vyraujantį EOL", () => {
  const md = "# T\r\n- [ ] vienas\r\n```\r\n- [ ] pavyzdys\r\n```\r\n  - [ ] du\r\n";
  const result = markTasksComplete(md);
  assert.equal(result.marked, 2);
  assert.match(result.text, /- \[x\] vienas/);
  assert.match(result.text, /- \[ \] pavyzdys/, "fence viduje nežymima");
  assert.match(result.text, /  - \[x\] du/, "įtrauka išsaugoma");
  assert.equal(result.text.includes("\r\n"), true, "CRLF EOL išlaikomas");
});

test("slugFromTask: auto- prefiksas, task id visada įeina, 50 simbolių riba", () => {
  assert.equal(slugFromTask("0042", "# Task\n## Tikslas\nSutvarkyti Ąžuolo modulį"), "auto-0042-sutvarkyti-azuolo-moduli");
  assert.equal(slugFromTask("0042", ""), "auto-0042");
  assert.equal(slugFromTask("", ""), "auto-task");
  const long = slugFromTask("0042", `# ${"labai ".repeat(30)}ilga antraštė`);
  assert.ok(long.length <= "auto-".length + 50, "slug dalis kerpama iki 50");
  assert.ok(!long.endsWith("-"), "nukirpimo uodegos brūkšnys pašalintas");
});

test("bucket-transition: taskBucketDir forma ir terminal vartas finishTaskInBucket", async () => {
  assert.match(taskBucketDir("/repo/AG", "queue"), /AG[\\/]tasks[\\/]queue$/);
  const calls: string[] = [];
  const store: TaskStateStorePort = {
    async moveTaskState(_from, toDir) {
      calls.push(`move:${toDir}`);
      return toDir;
    },
    async finishTaskState(_from, toDir) {
      calls.push(`finish:${toDir}`);
      return toDir;
    },
    async activateTaskFile(_taskFile, activeFile) {
      calls.push(`activate:${activeFile}`);
      return activeFile;
    },
  };
  await assert.rejects(
    () => finishTaskInBucket(store, "/repo/AG", "/from/x.md", "queue", "x.md"),
    /terminal bucket/,
    "ne-terminalinis bucket'as atmetamas prieš store kvietimą",
  );
  assert.deepEqual(calls, []);
  await finishTaskInBucket(store, "/repo/AG", "/from/x.md", "done", "x.md");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /finish:.*done$/);
});
