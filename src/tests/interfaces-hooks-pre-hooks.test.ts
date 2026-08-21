// VQ-502 (5/6-a) testai — PreToolUse vartai. Svarbiausia, ką jie pin'ina: fail-closed kryptys
// (neperskaitomas input, tuščias kelias, sugadinti readme įrodymai), vartų SEKA (pigios
// taisyklės prieš brangią nuosavybę), `..` segmentas atimantis carve-out'ą ir `unmanaged`
// šakos, kurios NETURI tyliai panaikinti scope lock sluoksnio.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { isGitMutationCommand } from "../domain/policies/index.js";
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

// ---------------------------------------------------------------------------
// domain: git mutacijos atpažinimas
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// runtime ownership
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// pre-hooks
// ---------------------------------------------------------------------------

function preHookPorts(
  fs: HookFsPort,
  input: {
    stdin?: string;
    ownership?: OwnershipWorld;
    contextThrows?: boolean;
    profile?: { source_roots?: string[]; architecture_doc?: string };
  } = {},
): PreHookPorts {
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

test("hookPreBash: neperskaitomas input blokuoja fail-closed", async () => {
  const world = fakeFs();
  const { io, err } = captureIo();
  const exit = await hookPreBash({
    ports: preHookPorts(world.fs, { stdin: "{ broken" }),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io,
  });

  assert.equal(exit, PRE_TOOL_BLOCK_EXIT_CODE);
  assert.match(err[1] ?? "", /blokuojama fail-closed/);
  assert.match(world.store.get("vq/logs/hooks.log") ?? "", /neperskaitomas hook input/);
});

test("hookPreBash: draudžiamas šablonas blokuoja PRIEŠ nuosavybės patikrą", async () => {
  const ownership = ownershipPorts();
  const world = fakeFs();
  const { io, err } = captureIo();

  const exit = await hookPreBash({
    ports: preHookPorts(world.fs, { stdin: BASH("rm -rf /"), ownership }),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io,
  });

  assert.equal(exit, PRE_TOOL_BLOCK_EXIT_CODE);
  assert.match(err[0] ?? "", /atitinka draudziama sablona/);
  assert.equal(ownership.authorityCalls.length, 0, "pigus vartas atmeta anksčiau už brangų");
});

test("hookPreBash: git mutacija be nuosavybės blokuoja; leidžiama komanda praeina", async () => {
  const denied = ownershipPorts({ authority: { status: "lease-expired", ok: false, reason: "lease baigėsi" } });
  const world = fakeFs();
  const { io, err } = captureIo();

  // Komanda privalo PRAEITI bash allowlist'ą, kad pasiektų nuosavybės vartus — kitaip testas
  // tikrintų ankstesnį vartą. Operatorinis merge kanalas yra allowlist'e ir yra mutacija.
  assert.equal(
    await hookPreBash({
      ports: preHookPorts(world.fs, { stdin: BASH("git merge worktree-operator-fix"), ownership: denied }),
      projectRoot: ROOT,
      runtimeRoot: RUNTIME_ROOT,
      io,
    }),
    PRE_TOOL_BLOCK_EXIT_CODE,
  );
  assert.match(err[0] ?? "", /neturi galiojančios worker lease \(lease-expired\)/);

  const allowed = fakeFs();
  assert.equal(
    await hookPreBash({
      ports: preHookPorts(allowed.fs, { stdin: BASH("git status --porcelain") }),
      projectRoot: ROOT,
      runtimeRoot: RUNTIME_ROOT,
      io: captureIo().io,
    }),
    0,
  );
  assert.match(allowed.store.get("vq/logs/hooks.log") ?? "", /bash: git status --porcelain/);
});

test("hookPreBash: neperskaitoma komandų politika NEBLOKUOJA (fail-safe)", async () => {
  const world = fakeFs();
  const exit = await hookPreBash({
    ports: preHookPorts(world.fs, { stdin: BASH("pnpm test"), contextThrows: true }),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io: captureIo().io,
  });
  assert.equal(exit, 0);
});

test("hookPreWrite: tuščias kelio laukas blokuoja fail-closed", async () => {
  const world = fakeFs();
  const { io, err } = captureIo();
  const exit = await hookPreWrite({
    ports: preHookPorts(world.fs, { stdin: JSON.stringify({ tool_name: "Write", tool_input: { target: "x.ts" } }) }),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io,
  });

  assert.equal(exit, PRE_TOOL_BLOCK_EXIT_CODE);
  assert.match(err[0] ?? "", /negavo rašymo kelio/);
});

test("hookPreWrite: rašymo politika atmeta PRIEŠ readme guard'ą", async () => {
  const world = fakeFs();
  const { io, err } = captureIo();
  const exit = await hookPreWrite({
    ports: preHookPorts(world.fs, { stdin: WRITE("vq/state/task-ledger.json") }),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io,
  });

  assert.equal(exit, PRE_TOOL_BLOCK_EXIT_CODE);
  assert.match(err[0] ?? "", /saugoma orkestratoriaus busena/);
  assert.match(world.store.get("vq/logs/hooks.log") ?? "", /orkestratoriaus failas/);
});

test("hookPreWrite: sugadinti readme įrodymai blokuoja, o ne virsta „nėra įrodymų“", async () => {
  const corrupt = fakeFs({ "vq/state/readme-read-events.json": "{ not an array" });
  const { io, err } = captureIo();
  assert.equal(
    await hookPreWrite({
      ports: preHookPorts(corrupt.fs, { stdin: WRITE("src/a.ts") }),
      projectRoot: ROOT,
      runtimeRoot: RUNTIME_ROOT,
      io,
    }),
    PRE_TOOL_BLOCK_EXIT_CODE,
  );
  assert.match(err[0] ?? "", /sugadintas arba suklastotas/);

  // Ne masyvas irgi yra klastojimas, ne tuščias įrodymų sąrašas.
  const notArray = fakeFs({ "vq/state/readme-read-events.json": '{"README.md":true}' });
  assert.equal(
    await hookPreWrite({
      ports: preHookPorts(notArray.fs, { stdin: WRITE("src/a.ts") }),
      projectRoot: ROOT,
      runtimeRoot: RUNTIME_ROOT,
      io: captureIo().io,
    }),
    PRE_TOOL_BLOCK_EXIT_CODE,
  );
});

test("hookPreWrite: be readme įrodymų blokuoja, su įrodymais ir nuosavybe — leidžia", async () => {
  const blocked = fakeFs({ "vq/state/readme-read-events.json": "[]" });
  const { io, err } = captureIo();
  assert.equal(
    await hookPreWrite({
      ports: preHookPorts(blocked.fs, { stdin: WRITE("src/a.ts") }),
      projectRoot: ROOT,
      runtimeRoot: RUNTIME_ROOT,
      io,
    }),
    PRE_TOOL_BLOCK_EXIT_CODE,
  );
  assert.match(err[0] ?? "", /readme-guard dar nepaleistas/);

  const allowed = fakeFs({ "vq/state/readme-read-events.json": JSON.stringify(["README.md"]) });
  const ok = captureIo();
  assert.equal(
    await hookPreWrite({
      ports: preHookPorts(allowed.fs, { stdin: WRITE("src/a.ts") }),
      projectRoot: ROOT,
      runtimeRoot: RUNTIME_ROOT,
      io: ok.io,
    }),
    0,
  );
  assert.match(allowed.store.get("vq/logs/hooks.log") ?? "", /rašymas leidžiamas: src\/a\.ts/);
});

test("hookPreWrite: architektūros dokumentas reikalaujamas TIK kai jis realiai yra diske", async () => {
  // Profilis jį deklaruoja, bet failo nėra — reikalavimas nekeliamas (task 885).
  const withoutDoc = fakeFs({ "vq/state/readme-read-events.json": JSON.stringify(["README.md"]) });
  assert.equal(
    await hookPreWrite({
      ports: preHookPorts(withoutDoc.fs, {
        stdin: WRITE("src/a.ts"),
        profile: { source_roots: ["src"], architecture_doc: "doc/architecture/README.md" },
      }),
      projectRoot: ROOT,
      runtimeRoot: RUNTIME_ROOT,
      io: captureIo().io,
    }),
    0,
  );

  const withDoc = fakeFs({
    "vq/state/readme-read-events.json": JSON.stringify(["README.md"]),
    "doc/architecture/README.md": "# arch\n",
  });
  const { io, err } = captureIo();
  assert.equal(
    await hookPreWrite({
      ports: preHookPorts(withDoc.fs, {
        stdin: WRITE("src/a.ts"),
        profile: { source_roots: ["src"], architecture_doc: "doc/architecture/README.md" },
      }),
      projectRoot: ROOT,
      runtimeRoot: RUNTIME_ROOT,
      io,
    }),
    PRE_TOOL_BLOCK_EXIT_CODE,
  );
  assert.match(err[0] ?? "", /doc\/architecture\/README\.md/);
});

test("hookPreWrite: nuosavybės atmetimas blokuoja paskutinis, jau praėjus pigiems vartams", async () => {
  const denied = ownershipPorts({ authority: { status: "foreign-lease", ok: false, reason: "svetimas lease" } });
  const world = fakeFs({ "vq/state/readme-read-events.json": JSON.stringify(["README.md"]) });
  const { io, err } = captureIo();

  const exit = await hookPreWrite({
    ports: preHookPorts(world.fs, { stdin: WRITE("src/a.ts"), ownership: denied }),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io,
  });

  assert.equal(exit, PRE_TOOL_BLOCK_EXIT_CODE);
  assert.match(err[0] ?? "", /worker lease \(foreign-lease\)/);
  assert.equal(denied.authorityCalls[0]?.guardedPath, "src/a.ts", "žinomas kelias siaurina aprėptį");
});
