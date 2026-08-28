// `/api/ui/rebuild` proceso paleidimo surišimas composition sluoksnyje (task 058-4).
//
// `src/tests/interfaces-http-ui-rebuild.test.ts` jau pin'ina `ensureUiRebuildRunning` elgesį su
// pilnai fake portais — čia tikrinama TIK composition adapteris: ar `spawnUiRebuildProcess`
// realiai paduoda FIKSUOTĄ `UI_REBUILD_COMMAND`/`UI_REBUILD_ARGS` į spawn'ą (komanda ateina iš
// interfaces, composition jos nekeičia), ir ar visas ciklas (started → already-running → failed
// su išvesties uodega) veikia per TIKRĄ `UiRebuildProcess` kontraktą, kurį ta funkcija grąžina.
// `spawn` STUB'INAMAS injekcija — testui NIEKADA nereikia realaus `pnpm build` paleidimo.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  spawnUiRebuildProcess,
  type UiRebuildOutputStream,
  type UiRebuildSpawnFn,
} from "../composition/ui/lifecycle-adapters.js";
import { uiRouterPorts } from "../composition/ui/router-adapters.js";
import {
  UI_REBUILD_ARGS,
  UI_REBUILD_COMMAND,
  ensureUiRebuildRunning,
  resetUiRebuildStateForTests,
  uiRebuildStatus,
  type UiRebuildDeps,
  type UiRebuildProcessPorts,
} from "../interfaces/http/ui-rebuild.js";

type Sandbox = { projectRoot: string; runtimeRoot: string };

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-ui-rebuild-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  await mkdir(runtimeRoot, { recursive: true });
  return { projectRoot, runtimeRoot };
}

/** Stebimas stdout/stderr srautas: registruoja klausytojus, testas juos iškviečia rankomis. */
function makeStream(): { stream: UiRebuildOutputStream; emit(chunk: string): void } {
  const listeners: Array<(chunk: Buffer) => void> = [];
  return {
    stream: {
      on: (_event, listener) => {
        listeners.push(listener);
        return undefined;
      },
    },
    emit: (chunk) => {
      for (const listener of listeners) listener(Buffer.from(chunk, "utf8"));
    },
  };
}

type FakeSpawn = {
  spawnFn: UiRebuildSpawnFn;
  calls: Array<{ command: string; args: readonly string[] }>;
  /** Paskutinio spawn'o vaikas — testai jį naudoja stdout/exit įvykiams sukelti. */
  lastChild(): { pid: number; emitStdout(chunk: string): void; triggerExit(code: number | null): void };
};

/** Vienas fiksuotas PID visiems vaikams — pakanka, nes `alivePids` sprendžia gyvumą, ne OS. */
function fakeSpawn(pid: number): FakeSpawn {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let last: { pid: number; emitStdout(chunk: string): void; triggerExit(code: number | null): void } | undefined;

  const spawnFn: UiRebuildSpawnFn = (command, args) => {
    calls.push({ command, args });
    const stdout = makeStream();
    const stderr = makeStream();
    const exitListeners: Array<(code: number | null) => void> = [];

    last = {
      pid,
      emitStdout: (chunk) => stdout.emit(chunk),
      triggerExit: (code) => {
        for (const listener of exitListeners) listener(code);
      },
    };

    return {
      pid,
      stdout: stdout.stream,
      stderr: stderr.stream,
      on: (event, listener) => {
        if (event === "exit") exitListeners.push(listener as (code: number | null) => void);
        return undefined;
      },
      unref: () => {},
    };
  };

  return {
    spawnFn,
    calls,
    lastChild: () => {
      if (!last) throw new Error("spawn dar nebuvo iškviestas");
      return last;
    },
  };
}

function world(sandbox: Sandbox, spawnFn: UiRebuildSpawnFn, alivePids: Set<number>): UiRebuildDeps {
  const store = new Map<string, string>();
  const ports: UiRebuildProcessPorts = {
    fs: {
      readTextFileIfExists: (p) => Promise.resolve(store.get(p)),
      writeTextFileAtomic: (p, content) => {
        store.set(p, content);
        return Promise.resolve();
      },
      makeDirectory: () => Promise.resolve(),
    },
    spawnUiRebuild: () => Promise.resolve(spawnUiRebuildProcess(sandbox.projectRoot, spawnFn)),
    processIsAlive: (pid) => alivePids.has(pid),
  };
  return { ports, runtimeRoot: sandbox.runtimeRoot };
}

async function flushAsyncWrites(): Promise<void> {
  // `finish()` composition viduje NELAUKIA `onExit` callback'o (fire-and-forget, kaip loop/UI
  // pusėje) — keli mikroužduočių ratai užtenka, nes testo fs yra grynas Map, ne realus diskas.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

test("spawnUiRebuildProcess: paduoda FIKSUOTĄ UI_REBUILD_COMMAND/UI_REBUILD_ARGS į spawn'ą", async () => {
  const sandbox = await makeSandbox();
  try {
    const fake = fakeSpawn(4242);
    const process1 = spawnUiRebuildProcess(sandbox.projectRoot, fake.spawnFn);
    assert.equal(process1.pid, 4242);
    assert.equal(fake.calls.length, 1);

    const call = fake.calls[0];
    assert.ok(call);
    if (process.platform === "win32") {
      // `run-process.ts#runProcess` etalonas: .cmd/.bat per `cmd.exe /d /s /c`, kad Node
      // (CVE-2024-27980) nesikeiktų EINVAL ir kad `shell:true` neatvertų DEP0190 injekcijos.
      assert.equal(call.command, "cmd.exe");
      assert.deepEqual(call.args, ["/d", "/s", "/c", "pnpm.cmd", ...UI_REBUILD_ARGS]);
    } else {
      assert.equal(call.command, UI_REBUILD_COMMAND);
      assert.deepEqual(call.args, UI_REBUILD_ARGS);
    }
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("ensureUiRebuildRunning per composition adapterį: pirmas prašymas → started", async () => {
  resetUiRebuildStateForTests();
  const sandbox = await makeSandbox();
  try {
    const fake = fakeSpawn(4242);
    const deps = world(sandbox, fake.spawnFn, new Set([4242]));

    const result = await ensureUiRebuildRunning(deps);
    assert.deepEqual(result, { status: "started", pid: 4242 });
    assert.equal(fake.calls.length, 1);
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("ensureUiRebuildRunning per composition adapterį: antras lygiagretus prašymas → already-running", async () => {
  resetUiRebuildStateForTests();
  const sandbox = await makeSandbox();
  try {
    const fake = fakeSpawn(4242);
    const alivePids = new Set([4242]);
    const deps = world(sandbox, fake.spawnFn, alivePids);

    await ensureUiRebuildRunning(deps);
    const second = await ensureUiRebuildRunning(deps);

    assert.deepEqual(second, { status: "already-running", pid: 4242 });
    assert.equal(fake.calls.length, 1, "antras spawn'as neįvyko");
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("ensureUiRebuildRunning per composition adapterį: nesėkmė → failed su išvesties uodega", async () => {
  resetUiRebuildStateForTests();
  const sandbox = await makeSandbox();
  try {
    const fake = fakeSpawn(4242);
    const alivePids = new Set([4242]);
    const deps = world(sandbox, fake.spawnFn, alivePids);

    await ensureUiRebuildRunning(deps);
    const child = fake.lastChild();
    child.emitStdout("TypeError: kažkas sudužo\n");
    alivePids.delete(4242);
    child.triggerExit(1);
    await flushAsyncWrites();

    const status = await uiRebuildStatus(deps);
    assert.deepEqual(status, { status: "failed", tail: "TypeError: kažkas sudužo\n" });
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("ensureUiRebuildRunning per composition adapterį: sėkmingas išėjimas → ok, o po jo leidžia naują startą", async () => {
  resetUiRebuildStateForTests();
  const sandbox = await makeSandbox();
  try {
    const fake = fakeSpawn(4242);
    const alivePids = new Set([4242]);
    const deps = world(sandbox, fake.spawnFn, alivePids);

    await ensureUiRebuildRunning(deps);
    const child = fake.lastChild();
    alivePids.delete(4242);
    child.triggerExit(0);
    await flushAsyncWrites();

    assert.deepEqual(await uiRebuildStatus(deps), { status: "ok" });

    const second = await ensureUiRebuildRunning(deps);
    assert.deepEqual(second, { status: "started", pid: 4242 });
    assert.equal(fake.calls.length, 2, "sėkmingo baigimo įrašas neblokuoja naujo starto");
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("uiRouterPorts: /api/ui/rebuild portas SURIŠTAS (ne `disabled`)", async () => {
  const sandbox = await makeSandbox();
  const agRoot = path.join(sandbox.projectRoot, "AG");
  await mkdir(agRoot, { recursive: true });
  try {
    const ports = uiRouterPorts({
      projectRoot: sandbox.projectRoot,
      runtimeRoot: sandbox.runtimeRoot,
      agRoot,
      logError: () => {},
    });

    // `.start` NEKVIEČIAMAS — realus `pnpm build` čia niekada neturi pasileisti. Pakanka
    // įrodyti, kad routeris nebegauna `undefined` (kas router pusėje virsta `disabled`).
    assert.equal(typeof ports.uiRebuild, "object");
    assert.equal(typeof ports.uiRebuild?.start, "function");
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});
