// Task 162: UI autostart'as ĮVARDIJA pasenusį serverio kodą (audito
// `docs/audits/ui-app-overview-2026-09-02.md` §2026-09-03 radinys). `ensureUiRunning`
// `already-running` šaka anksčiau gyvo šio projekto serverio amžiaus neklausdavo — valandų senumo
// procesas toliau aptarnaudavo seną kodą net kai `dist/.buildstamp` jau perrašytas po naujo build'o.
// Elgsena (serveris paliekamas gyvas) NEKINTA — tik prideda log eilutę, kai buildstamp naujesnis už
// paskutinį žinomą serverio įrašo laiką.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  ensureUiRunning,
  resetUiLifecycleStateForTests,
  type UiLifecycleDeps,
} from "../interfaces/http/ui-lifecycle.js";
import type { ProcessLifecyclePorts, SpawnedProcess } from "../interfaces/http/process-lifecycle-ports.js";
import { UI_SERVER_RECORD_SCHEMA_VERSION, uiServerRecordFile, type UiPortPorts } from "../interfaces/http/ui-port-store.js";
import { derivePreferredUiPort, projectFingerprint, uiUrl, type UiPortProbeResult } from "../interfaces/http/ui-port-rules.js";

const ROOT = path.resolve("/repo");
const RUNTIME = path.join(ROOT, "vq");
const STATE = path.join(RUNTIME, "state");
const NOW = new Date("2026-09-03T22:40:00.000Z");
const FINGERPRINT = projectFingerprint(ROOT, "linux");
const PORT = derivePreferredUiPort(ROOT, "linux");

type World = {
  ports: ProcessLifecyclePorts & { readBuildStamp?: () => Promise<string | undefined> };
  portPorts: UiPortPorts;
  store: Map<string, string>;
  out: string[];
  buildStamp: string | undefined;
};

function world(files: Record<string, string> = {}, buildStamp: string | undefined = undefined): World {
  const store = new Map(Object.entries(files));
  const out: string[] = [];
  const probes = new Map<number, UiPortProbeResult>();
  // Kandidato portas užimtas MŪSŲ fingerprint'u — `resolveUiPort` grąžina `already-running`, o ne
  // `available`, lygiai kaip audito scenarijuje: gyvas MŪSŲ serveris, antro kelti nereikia.
  probes.set(PORT, { state: "occupied", fingerprint: FINGERPRINT });

  const fs = {
    readTextFileIfExists: (p: string): Promise<string | undefined> => Promise.resolve(store.get(p)),
    writeTextFile: (p: string, content: string): Promise<void> => {
      store.set(p, content);
      return Promise.resolve();
    },
    writeTextFileAtomic: (p: string, content: string): Promise<void> => {
      store.set(p, content);
      return Promise.resolve();
    },
    makeDirectory: (): Promise<void> => Promise.resolve(),
    removeFileIfExists: (p: string): Promise<boolean> => Promise.resolve(store.delete(p)),
  };

  const ports: ProcessLifecyclePorts & { readBuildStamp?: () => Promise<string | undefined> } = {
    fs,
    runtime: {
      fs: {
        exists: (p) => Promise.resolve(store.has(p)),
        readTextFileIfExists: (p) => Promise.resolve(store.get(p)),
        writeTextFile: (p, content) => {
          store.set(p, content);
          return Promise.resolve();
        },
        makeDirectory: () => Promise.resolve(),
        fileMtimeMs: (p) => Promise.resolve(store.has(p) ? NOW.getTime() : undefined),
        removeIfExists: (p) => {
          store.delete(p);
          return Promise.resolve();
        },
      },
      // Booting/malonės lango šaka lieka NEĮSIJUNGUSI: jokio PID čia niekada nepripažįstame gyvu,
      // tad kelias visada patenka į `resolveUiPort` — būtent tą šaką ir tikrina šis failas.
      processIsAlive: () => false,
      now: () => NOW,
    },
    spawnLoop: () => Promise.reject(new Error("šiame teste loop'as nepaleidžiamas")),
    spawnUi: (): Promise<SpawnedProcess> => Promise.reject(new Error("already-running šaka vaiko nekelia")),
    processIsAlive: () => false,
    env: () => undefined,
    now: () => NOW,
    io: { out: (line) => out.push(line), error: (line) => out.push(line) },
    readBuildStamp: () => Promise.resolve(buildStamp),
  };

  const portPorts: UiPortPorts = {
    fs: {
      readTextFileIfExists: (p) => Promise.resolve(store.get(p)),
      writeTextFileAtomic: (p, content) => {
        store.set(p, content);
        return Promise.resolve();
      },
      makeDirectory: () => Promise.resolve(),
    },
    env: () => undefined,
    probe: (port) => Promise.resolve(probes.get(port) ?? { state: "free" }),
    now: () => NOW,
    platform: "linux",
  };

  return { ports, portPorts, store, out, buildStamp };
}

function deps(w: World): UiLifecycleDeps {
  return { ports: w.ports, portPorts: w.portPorts, projectRoot: ROOT, runtimeRoot: RUNTIME };
}

function serverRecord(updatedAt: string, pid = 26376): string {
  return JSON.stringify({
    schema_version: UI_SERVER_RECORD_SCHEMA_VERSION,
    port: PORT,
    url: uiUrl(PORT),
    project_fingerprint: FINGERPRINT,
    pid,
    updated_at: updatedAt,
  });
}

test("ensureUiRunning already-running: buildstamp NAUJESNIS už įrašą — įspėja, serverio nekelia iš naujo", async () => {
  resetUiLifecycleStateForTests();
  const w = world(
    { [uiServerRecordFile(STATE)]: serverRecord("2026-09-03T10:25:00.000Z", 26376) },
    "2026-09-03T22:35:00.000Z\n",
  );

  const result = await ensureUiRunning(deps(w));
  assert.deepEqual(result, { status: "already-running", pid: 26376, port: PORT });

  const warning = w.out.find((line) => line.includes("UI SERVES STALE DIST"));
  assert.ok(warning, "buildstamp naujesnis už serverio įrašą turi duoti įspėjimą");
  assert.match(warning ?? "", /pid=26376/);
  assert.match(warning ?? "", /started=2026-09-03T10:25:00\.000Z/);
  assert.match(warning ?? "", /buildstamp=2026-09-03T22:35:00\.000Z/);
  assert.match(warning ?? "", /restart the UI/);
});

test("ensureUiRunning already-running: buildstamp SENESNIS ar LYGUS — tyla", async () => {
  resetUiLifecycleStateForTests();
  const older = world(
    { [uiServerRecordFile(STATE)]: serverRecord("2026-09-03T22:35:00.000Z") },
    "2026-09-03T10:25:00.000Z",
  );
  await ensureUiRunning(deps(older));
  assert.equal(older.out.some((line) => line.includes("STALE")), false, "senesnis buildstamp nėra pasenimas");

  resetUiLifecycleStateForTests();
  const equal = world(
    { [uiServerRecordFile(STATE)]: serverRecord("2026-09-03T22:35:00.000Z") },
    "2026-09-03T22:35:00.000Z",
  );
  await ensureUiRunning(deps(equal));
  assert.equal(equal.out.some((line) => line.includes("STALE")), false, "lygus laikas nėra pasenimas");
});

test("ensureUiRunning already-running: trūkstamas buildstamp arba trūkstamas įrašas — tyla (nežinia nėra pasenimas)", async () => {
  resetUiLifecycleStateForTests();
  const noStamp = world({ [uiServerRecordFile(STATE)]: serverRecord("2026-09-03T10:25:00.000Z") }, undefined);
  await ensureUiRunning(deps(noStamp));
  assert.equal(noStamp.out.some((line) => line.includes("STALE")), false, "be stamp'o senumo įrodyti neįmanoma");

  resetUiLifecycleStateForTests();
  const noRecord = world({}, "2026-09-03T22:35:00.000Z");
  const result = await ensureUiRunning(deps(noRecord));
  assert.equal(result.status, "already-running");
  assert.equal(noRecord.out.some((line) => line.includes("STALE")), false, "be persistuoto įrašo pasenimas nežinomas");
});
