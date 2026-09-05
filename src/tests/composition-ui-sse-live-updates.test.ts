// VQ-504 (014-a-02): įrodo TIKRU wiring'u (ne fake hub'u), kad pasikeitus loop būsenai faile
// `runtimeRoot/state/claude-resume.json`, atidarytas GET /api/events SSE srautas atiduoda ANTRĄ
// freimą su pasikeitusia reikšme. `setInterval` portas paduodamas kaip no-op — pokytis
// transliuojamas RANKOMIS per `sseHub.checkAndBroadcast()` (žr. `command.ts:117` komentarą), kad
// testas nepriklausytų nuo 1500ms poll intervalo ar mtime granuliarumo.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createUiServer, listenUiServer } from "../composition/ui/server.js";
import { createSseHub } from "../interfaces/http/sse-service.js";
import { ssePorts } from "../composition/ui/sse-adapters.js";
import { createAttempt, openAttempt } from "../infrastructure/persistence/runtime-artifact-store.js";
import { createWorkerLease, workerLeaseFile } from "../application/scheduling/worker-lease-store.js";
import type { AttemptRef } from "../application/scheduling/worker-limits.js";

type ParsedFrame = { claudeStatus?: string | null; [key: string]: unknown };

/** Buferizuotas SSE freimų skaitytojas: viename `read()` gali ateiti dalinis arba keli blokai. */
function createFrameReader(reader: ReadableStreamDefaultReader<Uint8Array>): {
  next(): Promise<ParsedFrame>;
} {
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: ParsedFrame[] = [];

  const drainComplete = (): void => {
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine !== undefined) {
        pending.push(JSON.parse(dataLine.slice("data: ".length)) as ParsedFrame);
      }
      boundary = buffer.indexOf("\n\n");
    }
  };

  return {
    async next(): Promise<ParsedFrame> {
      while (pending.length === 0) {
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE srautas užsidarė prieš gaunant freimą");
        buffer += decoder.decode(value, { stream: true });
        drainComplete();
      }
      const frame = pending.shift();
      if (frame === undefined) throw new Error("nėra laukiamo freimo");
      return frame;
    },
  };
}

test("SSE srautas atspindi loop būsenos pasikeitimą claude-resume.json faile", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "vq-ui-sse-"));
  const errors: string[] = [];
  let listening: { port: number; close(): Promise<void> } | undefined;
  const controller = new AbortController();

  try {
    await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
    const resumePath = path.join(runtimeRoot, "state", "claude-resume.json");

    // 1. Pradinė būsena, PRIEŠ atidarant SSE jungtį.
    await writeFile(resumePath, JSON.stringify({ status: "started", task_id: "t1" }), "utf8");

    const sseHub = createSseHub({
      ...ssePorts({ projectRoot: runtimeRoot, runtimeRoot, logError: (message) => errors.push(message) }),
      // Taimeris paduodamas portu tam, kad testas galėtų jį sukti rankomis — žr. `command.ts:117`.
      setInterval: () => ({ clear: () => {} }),
    });

    const server = createUiServer({
      route: (request) =>
        Promise.resolve(request.url === "/api/events" ? { kind: "sse" } : { kind: "empty", status: 404 }),
      uiToken: "test-token",
      sse: sseHub,
      logError: (message) => errors.push(message),
    });
    listening = await listenUiServer(server, 0);

    const response = await fetch(`http://127.0.0.1:${listening.port}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const body = response.body;
    assert.ok(body, "SSE atsakymas privalo turėti kūną");
    const reader = body.getReader();
    const frames = createFrameReader(reader);

    // 2. Pirmas freimas ateina iš `addClient()` pradinės nuotraukos — visada šviežias.
    const frame1 = await frames.next();
    assert.equal(frame1["claudeStatus"], "started");

    // 3. Pakeičiama loop būsena.
    await writeFile(resumePath, JSON.stringify({ status: "running", task_id: "t1" }), "utf8");

    // 4. Pokytis transliuojamas RANKOMIS — pirmas kvietimas visada transliuoja, nes `lastMtimes`
    //    startuoja tuščias, tad nepriklauso nuo OS mtime granuliarumo.
    await sseHub.checkAndBroadcast();

    // 5. Antras freimas iš TO PATIES reader'io — turi atspindėti pasikeitusią būseną.
    const frame2 = await frames.next();
    assert.equal(frame2["claudeStatus"], "running");

    assert.notEqual(frame1["claudeStatus"], frame2["claudeStatus"]);
  } finally {
    controller.abort();
    if (listening !== undefined) await listening.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task 232 (auditas 2026-09-05, F9): `readGlobalActivity` gyvo šaltinio rezoliucija
// ---------------------------------------------------------------------------
//
// Iki šio task'o `readGlobalActivity` po `resolved.ok` grąžindavo globalų `vq/logs/claude-last.log`
// veidrodį. Worktree dispatch'e tėvo bandymo kopija EGZISTUOJA (manifestą rašo tėvas), o jos
// `claude-last` kanalas — ne (vaikas rašo su savo runtimeRoot), tad tas atvejis iškrisdavo tiesiai
// į ankstesnio NE-worktree paleidimo fosiliją: srautas reaguodavo į kopijos log'ą (`readActiveAttempt`
// jį stebi nuo task 139), o RODYDAVO valandų senumo svetimą komandą.
//
// Fosilija čia rašoma VISUOSE trijuose scenarijuose ir yra atpažįstama (`Read: fosilija.ts`) —
// kitaip testas negalėtų atskirti „gyvas šaltinis pasirinktas teisingai" nuo „veidrodis tuščias".

const LIVE_TASK = "0232";
const AGENT_BLOCK = "# Task\n\n## Agentai\n- primary: coder\n";
const RUN_ID = "r232";

/** Viena ndjson eilutė, iš kurios `buildAgentActivity` išveda `currentActivity`. */
function readToolCall(id: string, filePath: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: filePath } }] },
  });
}

type LiveWorld = { projectRoot: string; runtimeRoot: string };

/**
 * Gyvas slot'as bangos snapshot'e PLIUS rezoliuojamas tėvo bandymas be `claude-last` kanalo —
 * tiksliai ta būsena, kurią sukuria worktree dispatch'as.
 */
async function liveSlotWorld(): Promise<LiveWorld> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-232-sse-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  await mkdir(path.join(runtimeRoot, "state"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "logs"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "supervisor"), { recursive: true });

  // Globalus veidrodis su ATPAŽĮSTAMU turiniu: fosilija, kurios nė vienas gyvas kelias neturi grąžinti.
  await writeFile(path.join(runtimeRoot, "supervisor", "reformulated-task.md"), AGENT_BLOCK, "utf8");
  await writeFile(
    path.join(runtimeRoot, "logs", "claude-last.log"),
    `${readToolCall("t-fossil", "/repo/fosilija.ts")}\n`,
    "utf8",
  );

  // `readWaveSnapshotLiveSlots` reikalauja `worker_index`: be jo schema atmeta snapshot'ą, gyvo
  // slot'o nebelieka, ir testas praeitų dėl NETEISINGOS priežasties (globalus kelias be task id).
  await writeFile(
    path.join(runtimeRoot, "state", "wave-snapshot.json"),
    JSON.stringify({
      run_id: RUN_ID,
      wave_id: "wave-1",
      graph_hash: "gh-232",
      created_at: "2026-09-05T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z",
      live_slots: [{ worker_id: "w1", worker_index: 1, task_id: LIVE_TASK, attempt: 1 }],
    }),
    "utf8",
  );

  const ref: AttemptRef = { runId: RUN_ID, workerId: "w1", taskId: LIVE_TASK, attemptId: "a1" };
  const created = await createAttempt({
    runtimeRoot,
    ref,
    graphHash: "gh-232",
    policy: {},
    source: { origin: "queue-task" },
    createdAt: "2026-09-05T00:00:00.000Z",
  });
  assert.ok(created.ok, "bandymo kopija privalo atsirasti — be jos rezoliucija netikrina nieko");

  return { projectRoot, runtimeRoot };
}

/** Gyvas `held` lease su worktree keliu — tas pats šaltinis, kurį skaito `worktreeLiveSources`. */
async function placeWorktreeLease(world: LiveWorld, worktreeRelativePath: string): Promise<void> {
  const lease = createWorkerLease(
    { owner_id: "loop-w2", run_id: RUN_ID, worker_id: "w2", task_id: LIVE_TASK, attempt: 1 },
    { now: new Date(), fencingToken: 1, worktreePath: worktreeRelativePath },
  );
  const file = workerLeaseFile(world.projectRoot, "w2");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(lease), "utf8");
}

function globalActivityPorts(world: LiveWorld): ReturnType<typeof ssePorts> {
  return ssePorts({ ...world, logError: () => {} });
}

/**
 * `resolveActiveAttempt` (per `ssePorts`) rezoliuciją skaito iš PROCESO env, o šis testas pats gali
 * suktis worker'io dispatch'e su savo AG_* reikšmėmis. Fiksuojame jas, kad ref'as sutaptų
 * DETERMINISTIŠKAI, ir atstatome — kitaip nutekėjimas perrašytų šio failo pirmojo testo kelią.
 */
const ENV_KEYS = ["AG_RUNTIME_ARTIFACTS", "AG_RUN_ID", "AG_WORKER_ID", "AG_ATTEMPT_ID"] as const;

async function withPinnedAttemptEnv(scenario: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    process.env["AG_RUNTIME_ARTIFACTS"] = "1";
    process.env["AG_RUN_ID"] = RUN_ID;
    process.env["AG_WORKER_ID"] = "w1";
    process.env["AG_ATTEMPT_ID"] = "a1";
    await scenario();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("rezoliuotas bandymas be tėvo log'o: veikla ateina iš worktree kopijos, ne iš veidrodžio", async () => {
  await withPinnedAttemptEnv(async () => {
    const world = await liveSlotWorld();
    try {
      const worktreeRoot = path.join(world.projectRoot, "worktree1");
      await mkdir(path.join(worktreeRoot, "vq", "logs"), { recursive: true });
      await mkdir(path.join(worktreeRoot, "vq", "supervisor"), { recursive: true });
      await writeFile(
        path.join(worktreeRoot, "vq", "logs", "claude-last.log"),
        `${readToolCall("t-live", "/repo/kopija.ts")}\n`,
        "utf8",
      );
      await writeFile(path.join(worktreeRoot, "vq", "supervisor", "claude-visible-prompt.md"), AGENT_BLOCK, "utf8");
      await placeWorktreeLease(world, "worktree1");

      const activity = await globalActivityPorts(world).readGlobalActivity();

      assert.equal(activity.currentActivity, "Read: kopija.ts");
      assert.notEqual(activity.currentActivity, "Read: fosilija.ts");
      assert.equal(activity.taskId, LIVE_TASK);
      assert.equal(activity.claudeStatus, "running");
    } finally {
      await rm(world.projectRoot, { recursive: true, force: true });
    }
  });
});

test("rezoliuotas bandymas be tėvo log'o ir be lease: TUŠČIA veikla, o ne fosilija", async () => {
  await withPinnedAttemptEnv(async () => {
    const world = await liveSlotWorld();
    try {
      const activity = await globalActivityPorts(world).readGlobalActivity();

      // Gyvo šaltinio nėra — tada teisinga reikšmė yra „žinome tik tapatybę", o ne svetimo
      // paleidimo turinys.
      assert.equal(activity.currentActivity, null);
      assert.deepEqual(activity.chain, []);
      assert.equal(activity.taskId, LIVE_TASK);
      assert.equal(activity.claudeStatus, "running");
    } finally {
      await rm(world.projectRoot, { recursive: true, force: true });
    }
  });
});

test("ne-worktree dispatch: tėvo attempt kanalui atsiradus lieka esamas globalus kelias", async () => {
  await withPinnedAttemptEnv(async () => {
    const world = await liveSlotWorld();
    try {
      // Tėvas rašo pats — tada globalus veidrodis PRIKLAUSO šiam vykdymui, ir jis nėra fosilija.
      const ref: AttemptRef = { runId: RUN_ID, workerId: "w1", taskId: LIVE_TASK, attemptId: "a1" };
      const handle = await openAttempt(world.runtimeRoot, ref);
      assert.ok(handle.ok);
      await handle.data.appendLog("claude-last", readToolCall("t-parent", "/repo/tevas.ts"));

      const activity = await globalActivityPorts(world).readGlobalActivity();

      // Šis scenarijus įrodo ir tai, kad ankstesniuose dviejuose fosilija BUVO pasiekiama: tas pats
      // veidrodis, tie patys keliai — skiriasi tik tėvo kanalo egzistavimas.
      assert.equal(activity.currentActivity, "Read: fosilija.ts");
    } finally {
      await rm(world.projectRoot, { recursive: true, force: true });
    }
  });
});
