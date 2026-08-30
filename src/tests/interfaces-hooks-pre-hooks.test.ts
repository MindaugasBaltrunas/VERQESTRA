// VQ-502 (5/6-a) testai — PreToolUse vartai. Svarbiausia, ką jie pin'ina: fail-closed kryptys
// (neperskaitomas input, tuščias kelias, sugadinti readme įrodymai), vartų SEKA (pigios
// taisyklės prieš brangią nuosavybę), `..` segmentas atimantis carve-out'ą ir `unmanaged`
// šakos, kurios NETURI tyliai panaikinti scope lock sluoksnio.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { isGitMutationCommand } from "../domain/policies/index.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { collectKnownTaskIds } from "../interfaces/hooks/index.js";
import type { HookFsPort, HookIo } from "../interfaces/hooks/protocol.js";
import {
  evaluateRuntimeOwnership,
  type RuntimeOwnershipPorts,
} from "../interfaces/hooks/runtime-ownership.js";
import {
  PRE_TOOL_BLOCK_EXIT_CODE,
  hookPreBash,
  hookPreWrite,
  type PreHookPorts,
} from "../interfaces/hooks/pre-hooks.js";

const ROOT = path.resolve("/repo");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const norm = (value: string): string => value.replace(/\\/g, "/");
const rel = (absolute: string): string => norm(path.relative(ROOT, absolute));

function captureIo(): { io: HookIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

function fakeFs(files: Record<string, string> = {}): { fs: HookFsPort; store: Map<string, string> } {
  const store = new Map(Object.entries(files));
  return {
    store,
    fs: {
      exists: async (p) => store.has(rel(p)),
      readTextFileIfExists: async (p) => store.get(rel(p)),
      writeTextFile: async (p, text) => void store.set(rel(p), text),
      appendTextFile: async (p, text) => void store.set(rel(p), `${store.get(rel(p)) ?? ""}${text}`),
      makeDirectory: async () => {},
    },
  };
}

// --- domain: git mutacijos atpažinimas --------------------------------------------------------

test("isGitMutationCommand: mutuojantys verbai pagaunami ir grandinės viduryje, read-only — ne", () => {
  assert.equal(isGitMutationCommand("git commit -m x"), true);
  assert.equal(isGitMutationCommand("pnpm build && git push"), true);
  assert.equal(isGitMutationCommand("echo x; git reset --hard HEAD"), true);
  assert.equal(isGitMutationCommand("git worktree add ../w2"), true);

  // Read-only verbai pro vartus neina — diagnostika turi likti įmanoma ir netekus nuosavybės.
  assert.equal(isGitMutationCommand("git status --porcelain"), false);
  assert.equal(isGitMutationCommand("git log -1"), false);
  assert.equal(isGitMutationCommand("git diff HEAD"), false);
  assert.equal(isGitMutationCommand("pnpm test"), false);
});

// --- runtime ownership -------------------------------------------------------------------------

type OwnershipWorld = {
  ports: RuntimeOwnershipPorts;
  logs: string[];
  scopeCalls: Array<{ repoRelativePath: string; leaseId?: string }>;
  authorityCalls: Array<{ guardedPath?: string; taskId?: string }>;
};

function ownershipPorts(
  input: {
    authority?: { status: string; ok: boolean; reason: string; lease?: { lease_id: string } };
    scope?: { status: string; ok: boolean; reason: string };
    liveWorktrees?: string[];
    taken?: string[];
  } = {},
): OwnershipWorld {
  const logs: string[] = [];
  const scopeCalls: Array<{ repoRelativePath: string; leaseId?: string }> = [];
  const authorityCalls: Array<{ guardedPath?: string; taskId?: string }> = [];
  const taken = new Set((input.taken ?? []).map(norm));

  return {
    logs,
    scopeCalls,
    authorityCalls,
    ports: {
      // Fake realpath yra tapatybė — symlink'ų elgesį dengia kompozicijos adapteris.
      resolveDeepestRealPath: async (p) => norm(p),
      pathIsTaken: async (p) => taken.has(norm(p)),
      liveLeaseWorktreePaths: async () => input.liveWorktrees ?? [],
      authorizeWorkerRuntimeMutation: async (call) => {
        authorityCalls.push({
          ...(call.guardedPath === undefined ? {} : { guardedPath: call.guardedPath }),
          ...(call.taskId === undefined ? {} : { taskId: call.taskId }),
        });
        return input.authority ?? { status: "unmanaged", ok: true, reason: "lease runtime off" };
      },
      authorizeScopedWrite: async (call) => {
        scopeCalls.push({
          repoRelativePath: call.repoRelativePath,
          ...(call.leaseId === undefined ? {} : { leaseId: call.leaseId }),
        });
        return input.scope ?? { status: "free", ok: true, reason: "" };
      },
      appendHookLog: async (line) => void logs.push(line),
    },
  };
}

test("evaluateRuntimeOwnership: naujas queue failas gauna carve-out'ą ir jis pažymimas žurnale", async () => {
  const world = ownershipPorts();
  const verdict = await evaluateRuntimeOwnership(world.ports, ROOT, {
    filePath: "AG/tasks/queue/0042.md",
    subject: "rašymas",
  });

  assert.equal(verdict, undefined);
  assert.equal(world.authorityCalls.length, 0, "carve-out sustabdo dar prieš lease patikrą");
  // Carve-out yra vartų susilpninimas — be pėdsako jis neatskiriamas nuo „vartai negaliojo".
  assert.match(world.logs[0] ?? "", /lease vartai netaikomi: AG\/tasks\/queue\/0042\.md \(new-queue-file\)/);
});

test("evaluateRuntimeOwnership: `..` segmentas ATIMA carve-out'ą (fail-closed)", async () => {
  const world = ownershipPorts({
    authority: { status: "foreign-lease", ok: false, reason: "svetimas lease" },
  });
  const verdict = await evaluateRuntimeOwnership(world.ports, ROOT, {
    filePath: "AG/tasks/queue/../../src/a.ts",
    subject: "rašymas",
  });

  assert.equal(verdict?.reason, "worker lease: foreign-lease");
  // Aprėptis nesiaurinama, nes kelio nustatyti negalima — gyvi lease'ai gina visą medį.
  assert.equal(world.authorityCalls[0]?.guardedPath, undefined);
});

test("evaluateRuntimeOwnership: esamas queue failas carve-out'o negauna", async () => {
  const world = ownershipPorts({ taken: [norm(path.join(ROOT, "AG/tasks/queue/0042.md"))] });
  await evaluateRuntimeOwnership(world.ports, ROOT, { filePath: "AG/tasks/queue/0042.md", subject: "rašymas" });
  assert.equal(world.authorityCalls.length, 1, "užimtas vardas eina per pilnus vartus");
});

test("evaluateRuntimeOwnership: unmanaged BE lease'o praleidžia, SU lease'u vis tiek tikrina scope lock", async () => {
  const withoutLease = ownershipPorts({ authority: { status: "unmanaged", ok: true, reason: "off" } });
  assert.equal(
    await evaluateRuntimeOwnership(withoutLease.ports, ROOT, { filePath: "src/a.ts", subject: "rašymas" }),
    undefined,
  );
  assert.equal(withoutLease.scopeCalls.length, 0);

  const withLease = ownershipPorts({
    authority: { status: "unmanaged", ok: true, reason: "off", lease: { lease_id: "L1" } },
  });
  assert.equal(
    await evaluateRuntimeOwnership(withLease.ports, ROOT, { filePath: "src/a.ts", subject: "rašymas" }),
    undefined,
  );
  assert.equal(withLease.scopeCalls.length, 1, "siauresnė lease aprėptis negali panaikinti antro sluoksnio");
  assert.equal(withLease.scopeCalls[0]?.leaseId, undefined, "unmanaged šakoje leaseId neperduodamas");
});

test("evaluateRuntimeOwnership: scope lock atmetimas blokuoja; valdomame režime perduodamas leaseId", async () => {
  const world = ownershipPorts({
    authority: { status: "authorized", ok: true, reason: "", lease: { lease_id: "L7" } },
    scope: { status: "locked-by-other", ok: false, reason: "kitas workeris" },
  });
  const verdict = await evaluateRuntimeOwnership(world.ports, ROOT, { filePath: "src/a.ts", subject: "rašymas" });

  assert.equal(verdict?.reason, "scope lock: locked-by-other");
  assert.equal(world.scopeCalls[0]?.leaseId, "L7");
  assert.equal(world.scopeCalls[0]?.repoRelativePath, "src/a.ts");
});

test("evaluateRuntimeOwnership: be filePath (git kelias) scope lock netikrinamas", async () => {
  const world = ownershipPorts({ authority: { status: "authorized", ok: true, reason: "", lease: { lease_id: "L1" } } });
  assert.equal(await evaluateRuntimeOwnership(world.ports, ROOT, { subject: "git commit" }), undefined);
  assert.equal(world.scopeCalls.length, 0);
  assert.equal(world.authorityCalls[0]?.guardedPath, undefined, "git veiksmas liečia visą medį");
});

// --- pre-hooks -----------------------------------------------------------------------------------

type PortsExtra = {
  stdin?: string;
  ownership?: OwnershipWorld;
  contextThrows?: boolean;
  profile?: { source_roots?: string[]; architecture_doc?: string };
};

function preHookPorts(fs: HookFsPort, input: PortsExtra = {}): PreHookPorts {
  const ownership = input.ownership ?? ownershipPorts();
  return {
    ...ownership.ports,
    fs,
    stdin: { readStdin: async () => input.stdin ?? "" },
    loadProjectProfile: async () => input.profile,
    checkCommandContext: async () => {
      if (input.contextThrows) throw new Error("policy neperskaitoma");
      return { configuredSpawnChecks: [], activeStacks: [] };
    },
    now: () => new Date("2026-08-21T00:00:00.000Z"),
  };
}

const BASH = (command: string): string => JSON.stringify({ tool_name: "Bash", tool_input: { command } });
const WRITE = (filePath: string): string => JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath } });

/** Vienas `hookPreBash` bėgimas su pasirenkamu ownership/contextThrows overridu. */
async function runBash(
  stdin: string,
  extra: Omit<PortsExtra, "stdin"> = {},
): Promise<{ exit: number; err: string[]; store: Map<string, string> }> {
  const world = fakeFs();
  const { io, err } = captureIo();
  const exit = await hookPreBash({
    ports: preHookPorts(world.fs, { stdin, ...extra }),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io,
  });
  return { exit, err, store: world.store };
}

/** Vienas `hookPreWrite` bėgimas: `files` — pradinis fakeFs turinys, `stdin` — hook payload'as. */
async function runWrite(
  files: Record<string, string>,
  stdin: string,
  extra: Omit<PortsExtra, "stdin"> = {},
): Promise<{ exit: number; err: string[]; store: Map<string, string> }> {
  const world = fakeFs(files);
  const { io, err } = captureIo();
  const exit = await hookPreWrite({
    ports: preHookPorts(world.fs, { stdin, ...extra }),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io,
  });
  return { exit, err, store: world.store };
}

test("hookPreBash: neperskaitomas input blokuoja fail-closed", async () => {
  const { exit, err, store } = await runBash("{ broken");
  assert.equal(exit, PRE_TOOL_BLOCK_EXIT_CODE);
  assert.match(err[1] ?? "", /blokuojama fail-closed/);
  assert.match(store.get("vq/logs/hooks.log") ?? "", /neperskaitomas hook input/);
});

test("hookPreBash: draudžiamas šablonas blokuoja PRIEŠ nuosavybės patikrą", async () => {
  const ownership = ownershipPorts();
  const { exit, err } = await runBash(BASH("rm -rf /"), { ownership });
  assert.equal(exit, PRE_TOOL_BLOCK_EXIT_CODE);
  assert.match(err[0] ?? "", /atitinka draudziama sablona/);
  assert.equal(ownership.authorityCalls.length, 0, "pigus vartas atmeta anksčiau už brangų");
});

test("hookPreBash: git mutacija be nuosavybės blokuoja; leidžiama komanda praeina", async () => {
  const denied = ownershipPorts({ authority: { status: "lease-expired", ok: false, reason: "lease baigėsi" } });
  // Komanda privalo PRAEITI bash allowlist'ą, kad pasiektų nuosavybės vartus — kitaip testas
  // tikrintų ankstesnį vartą. Operatorinis merge kanalas yra allowlist'e ir yra mutacija.
  const blocked = await runBash(BASH("git merge worktree-operator-fix"), { ownership: denied });
  assert.equal(blocked.exit, PRE_TOOL_BLOCK_EXIT_CODE);
  assert.match(blocked.err[0] ?? "", /neturi galiojančios worker lease \(lease-expired\)/);

  const allowed = await runBash(BASH("git status --porcelain"));
  assert.equal(allowed.exit, 0);
  assert.match(allowed.store.get("vq/logs/hooks.log") ?? "", /bash: git status --porcelain/);
});

test("hookPreBash: neperskaitoma komandų politika NEBLOKUOJA (fail-safe)", async () => {
  const { exit } = await runBash(BASH("pnpm test"), { contextThrows: true });
  assert.equal(exit, 0);
});

test("hookPreWrite: tuščias kelio laukas blokuoja fail-closed", async () => {
  const { exit, err } = await runWrite({}, JSON.stringify({ tool_name: "Write", tool_input: { target: "x.ts" } }));
  assert.equal(exit, PRE_TOOL_BLOCK_EXIT_CODE);
  assert.match(err[0] ?? "", /negavo rašymo kelio/);
});

test("hookPreWrite: rašymo politika atmeta PRIEŠ readme guard'ą", async () => {
  const { exit, err, store } = await runWrite({}, WRITE("vq/state/task-ledger.json"));
  assert.equal(exit, PRE_TOOL_BLOCK_EXIT_CODE);
  assert.match(err[0] ?? "", /saugoma orkestratoriaus busena/);
  assert.match(store.get("vq/logs/hooks.log") ?? "", /orkestratoriaus failas/);
});

test("hookPreWrite: sugadinti readme įrodymai blokuoja, o ne virsta „nėra įrodymų“", async () => {
  const corrupt = await runWrite({ "vq/state/readme-read-events.json": "{ not an array" }, WRITE("src/a.ts"));
  assert.equal(corrupt.exit, PRE_TOOL_BLOCK_EXIT_CODE);
  assert.match(corrupt.err[0] ?? "", /sugadintas arba suklastotas/);

  // Ne masyvas irgi yra klastojimas, ne tuščias įrodymų sąrašas.
  const notArray = await runWrite({ "vq/state/readme-read-events.json": '{"README.md":true}' }, WRITE("src/a.ts"));
  assert.equal(notArray.exit, PRE_TOOL_BLOCK_EXIT_CODE);
});

test("hookPreWrite: be readme įrodymų blokuoja, su įrodymais ir nuosavybe — leidžia", async () => {
  const blocked = await runWrite({ "vq/state/readme-read-events.json": "[]" }, WRITE("src/a.ts"));
  assert.equal(blocked.exit, PRE_TOOL_BLOCK_EXIT_CODE);
  assert.match(blocked.err[0] ?? "", /readme-guard dar nepaleistas/);

  const allowed = await runWrite({ "vq/state/readme-read-events.json": JSON.stringify(["README.md"]) }, WRITE("src/a.ts"));
  assert.equal(allowed.exit, 0);
  assert.match(allowed.store.get("vq/logs/hooks.log") ?? "", /rašymas leidžiamas: src\/a\.ts/);
});

test("hookPreWrite: architektūros dokumentas reikalaujamas TIK kai jis realiai yra diske", async () => {
  const profile = { source_roots: ["src"], architecture_doc: "doc/architecture/README.md" };
  // Profilis jį deklaruoja, bet failo nėra — reikalavimas nekeliamas (task 885).
  const withoutDoc = await runWrite(
    { "vq/state/readme-read-events.json": JSON.stringify(["README.md"]) },
    WRITE("src/a.ts"),
    { profile },
  );
  assert.equal(withoutDoc.exit, 0);

  const withDoc = await runWrite(
    { "vq/state/readme-read-events.json": JSON.stringify(["README.md"]), "doc/architecture/README.md": "# arch\n" },
    WRITE("src/a.ts"),
    { profile },
  );
  assert.equal(withDoc.exit, PRE_TOOL_BLOCK_EXIT_CODE);
  assert.match(withDoc.err[0] ?? "", /doc\/architecture\/README\.md/);
});

test("hookPreWrite: nuosavybės atmetimas blokuoja paskutinis, jau praėjus pigiems vartams", async () => {
  const denied = ownershipPorts({ authority: { status: "foreign-lease", ok: false, reason: "svetimas lease" } });
  const { exit, err } = await runWrite(
    { "vq/state/readme-read-events.json": JSON.stringify(["README.md"]) },
    WRITE("src/a.ts"),
    { ownership: denied },
  );
  assert.equal(exit, PRE_TOOL_BLOCK_EXIT_CODE);
  assert.match(err[0] ?? "", /worker lease \(foreign-lease\)/);
  assert.equal(denied.authorityCalls[0]?.guardedPath, "src/a.ts", "žinomas kelias siaurina aprėptį");
});

// --- 071-a-02: etalono struktūros vartai AG/tasks/{queue,active,delegated}/*.md ----------------

/** Minimal etalono-shaped task; viena šaltinio eilutė, kad file-length vartai netemptų. */
const VALID_ETALONAS_TASK =
  "# Task\n\n## Spec source\nopenspec/changes/example\n\n## Tikslas\nProblema su irodymu.\n\n## Agentai\nreadme-guard -> coder -> tester\n\n## Failai\nLeidziama:\n- `src/domain/example.ts`\n\nDraudziama:\n- `dist/**`\n- `node_modules/**`\n\n## Veiksmas\n- Padaryti X.\n\n## Patikra\n- `pnpm build`\n- `pnpm test`\n\n## Stop\nCommit'ink, kai patikros zalios.\n\n## Neitraukta\nY liks kitam task'ui.\n";
const NO_STOP = VALID_ETALONAS_TASK.replace("## Stop\nCommit'ink, kai patikros zalios.\n\n", "");
const readmeOkFiles = (extra: Record<string, string> = {}): Record<string, string> => ({
  "vq/state/readme-read-events.json": JSON.stringify(["README.md"]),
  ...extra,
});
const WRITE_CONTENT = (p: string, content: string): string =>
  JSON.stringify({ tool_name: "Write", tool_input: { file_path: p, content } });
const EDIT_CONTENT = (p: string, o: string, n: string): string =>
  JSON.stringify({ tool_name: "Edit", tool_input: { file_path: p, old_string: o, new_string: n } });

type RuleCase = { bucket: string; ruleId: string; ledger?: Record<string, unknown>; mutate: (t: string) => string };
const RULE_CASES: RuleCase[] = [
  { bucket: "queue", ruleId: "mandatory-section-missing", mutate: () => NO_STOP },
  { bucket: "active", ruleId: "failai-wildcard-without-justification", mutate: (t) => t.replace("- `src/domain/example.ts`", "- `src/tests/**`") },
  { bucket: "delegated", ruleId: "priklausomybe-placeholder", mutate: (t) => t.replace("## Tikslas", "## Priklausomybės\n- none\n\n## Tikslas") },
  { bucket: "queue", ruleId: "priklausomybe-unknown-id", ledger: { "010-zinomas": {} }, mutate: (t) => t.replace("## Tikslas", "## Priklausomybės\n- 999-nezinomas\n\n## Tikslas") },
  { bucket: "queue", ruleId: "patikra-unknown-command", mutate: (t) => t.replace("- `pnpm test`", "- `pnpm lint`") },
];

test("hookPreWrite: kiekviena etalono taisyklė blokuoja su savo ruleId ir etalono nuoroda", async () => {
  for (const { bucket, mutate, ledger, ruleId } of RULE_CASES) {
    const files = readmeOkFiles(ledger ? { "vq/state/task-ledger.json": JSON.stringify(ledger) } : {});
    const stdin = WRITE_CONTENT(`AG/tasks/${bucket}/099-pvz.md`, mutate(VALID_ETALONAS_TASK));
    const { exit, err } = await runWrite(files, stdin);
    assert.equal(exit, PRE_TOOL_BLOCK_EXIT_CODE, ruleId);
    assert.match(err[0] ?? "", new RegExp(`\\(${ruleId}\\)`), ruleId);
    assert.match(err[0] ?? "", /000-etalonas\.md/, ruleId);
  }
});

test("hookPreWrite: etalonui atitinkantis task'as leidžiamas per Write, Edit ir žinomą Priklausomybės id", async () => {
  const write = await runWrite(readmeOkFiles(), WRITE_CONTENT("AG/tasks/queue/095-pvz.md", VALID_ETALONAS_TASK));
  assert.equal(write.exit, 0);

  // Edit: busimas turinys skaičiuojamas iš disko esančio (invalid) failo + pakeitimo.
  const tail = "## Neitraukta\nY liks kitam task'ui.\n";
  const restored = "## Stop\nCommit'ink, kai patikros zalios.\n\n## Neitraukta\nY liks kitam task'ui.\n";
  const editFiles = readmeOkFiles({ "AG/tasks/queue/096-pvz.md": NO_STOP });
  const edit = await runWrite(editFiles, EDIT_CONTENT("AG/tasks/queue/096-pvz.md", tail, restored));
  assert.equal(edit.exit, 0);

  const withKnownDep = VALID_ETALONAS_TASK.replace("## Tikslas", "## Priklausomybės\n- 999-zinomas\n\n## Tikslas");
  const knownFiles = readmeOkFiles({ "vq/state/task-ledger.json": JSON.stringify({ "999-zinomas": {} }) });
  const knownDep = await runWrite(knownFiles, WRITE_CONTENT("AG/tasks/queue/097-pvz.md", withKnownDep));
  assert.equal(knownDep.exit, 0);
});

test("hookPreWrite: examples/done/human-review bucket'ai praleidžiami be etalono validacijos", async () => {
  for (const filePath of [
    "AG/tasks/examples/000-etalonas.md",
    "AG/tasks/done/010-pvz.md",
    "AG/tasks/human-review/011-pvz.md",
  ]) {
    const { exit } = await runWrite(readmeOkFiles(), WRITE_CONTENT(filePath, NO_STOP));
    assert.equal(exit, 0, filePath);
  }
});

test("hookPreWrite: visi esami AG/tasks/queue ir AG/tasks/active failai atitinka etalono struktūrą", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const repoRoot = path.resolve(process.cwd());
  const runtimeRoot = path.join(repoRoot, "vq");
  const bucketFiles = async (bucket: string): Promise<string[]> => {
    const dir = path.join(repoRoot, "AG", "tasks", bucket);
    try {
      return (await readdir(dir)).filter((name) => name.endsWith(".md")).map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  };

  // `collectKnownTaskIds` (žr. `pre-hooks.ts`) yra TIKRAS domenas: bucket'ų failai SĄJUNGOJE su
  // ledger'iu, ne vien bucket'ai. Anksčiau čia buvo siauresnė kopija be ledger sąjungos — ji
  // klaidingai skelbė `priklausomybe-unknown-id` task'ui, kuris dispatch'o metu laikinai gyvena
  // ne queue/done bucket'e (pvz. `active`/`delegated`), bet TURI ledger įrašą (2026-08-30
  // incidentas, žr. interfaces-hooks-pre-hooks-known-ids.test.ts).
  const knownTaskIds = await collectKnownTaskIds(nodeFsAdapter, repoRoot, runtimeRoot);

  const { validateTaskAgainstEtalonas } = await import("../domain/tasks/etalonas-rules.js");
  for (const bucket of ["queue", "active"]) {
    for (const file of await bucketFiles(bucket)) {
      const violations = validateTaskAgainstEtalonas(await readFile(file, "utf8"), knownTaskIds);
      assert.deepEqual(violations, [], `${file}: ${JSON.stringify(violations)}`);
    }
  }
});
