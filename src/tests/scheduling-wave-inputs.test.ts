// VQ-504 (42/N) testai — bangos įvestys ir pool'o perplanavimas.
//
// Kertinės savybės: efektyvus slot'ų skaičius yra PREFIKSAS (ne kiekis), o pool'o perplanavimas
// atlaisvina kiekvieną išduotą, bet nepanaudotą lease'ą — kitaip jis tris valandas blokuotų
// task'o dispatch'ą.

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWorkerRequest, runnableSlotPrefix } from "../application/scheduling/wave-inputs.js";
import { planWavePool, type SlotProvisionTarget } from "../application/scheduling/wave-pool-planning.js";
import type { LoopControlState } from "../application/scheduling/loop-control-store.js";
import type { WavePlan } from "../application/scheduling/schedule-next-wave.js";

function control(w1: string, w2: string, invalid?: string): LoopControlState {
  return { slots: { w1: { mode: w1 }, w2: { mode: w2 } }, ...(invalid === undefined ? {} : { invalid }) } as LoopControlState;
}

test("runnableSlotPrefix skaičiuoja PREFIKSĄ, ne kiekį", () => {
  assert.equal(runnableSlotPrefix(control("run", "run")), 2);
  assert.equal(runnableSlotPrefix(control("run", "drain")), 1);
  // Pertrauka viduryje nutraukia skaičiavimą: antras slot'as be pirmo neturi prasmės.
  assert.equal(runnableSlotPrefix(control("drain", "run")), 0);
  assert.equal(runnableSlotPrefix(control("drain", "drain")), 0);
});

test("visi slot'ai sustabdyti — efektyvus skaičius NENUKRENTA žemiau vieno", () => {
  const resolution = resolveWorkerRequest({ requested: 2, control: control("drain", "drain") });
  // Nulis reikštų „banga be slot'ų", ir planuotojas tai matytų kaip tuščią eilę, o ne kaip
  // sustabdytą darbą. Sustabdymo semantiką vykdo dispatch'o vartai, ne planavimas.
  assert.equal(resolution.effective, 1);
});

test("valdiklių būsena ir netinkamos reikšmės patenka į eilutę", () => {
  const resolution = resolveWorkerRequest({
    requested: 2,
    control: control("run", "drain", "unreadable"),
    invalidRequest: "out-of-range",
  });
  assert.equal(resolution.requested, 2);
  assert.equal(resolution.effective, 1);
  assert.ok(resolution.line?.includes("control=w2:drain"));
  assert.ok(resolution.line?.includes("effective=1"));
  assert.ok(resolution.line?.includes("invalid=out-of-range"));
  assert.ok(resolution.line?.includes("control_invalid=unreadable"));
});

test("ta pati eilutė antrą kartą NERAŠOMA", () => {
  const first = resolveWorkerRequest({ requested: 1, control: control("run", "run") });
  assert.ok(first.line !== undefined);
  const second = resolveWorkerRequest({ requested: 1, control: control("run", "run"), lastLogged: first.line });
  assert.equal(second.line, undefined, "kartojimosi filtras yra gryna taisyklė, ne paslėpta būsena");
});

function wavePlan(): WavePlan {
  return {
    scheduler_version: 1,
    wave_id: "w1",
    wave_sequence: 1,
    graph_hash: "h",
    max_workers: 2,
    ready: [
      { task_id: "0001", file: "AG/tasks/queue/0001.md", blocked_by: [], depth: 0 },
      { task_id: "0002", file: "AG/tasks/queue/0002.md", blocked_by: [], depth: 0 },
    ],
    blocked: [],
    external_dependencies: [],
    cycles: [],
  };
}

test("vieno slot'o banga lease'ų NEIŠDUODA", async () => {
  let provisionCalls = 0;
  await planWavePool({
    runId: "r1",
    current: wavePlan(),
    requestedWorkers: 1,
    primaryClaimSupported: false,
    now: () => "2026-08-21T12:00:00.000Z",
    log: () => Promise.resolve(),
    recordEvent: () => Promise.resolve(),
    readIsolationInputs: () => Promise.resolve({ leases: [] }),
    toWorkerCandidates: () => [],
    rememberCandidate: () => {},
    provisionMissingSlotLeases: () => {
      provisionCalls += 1;
      return Promise.resolve([]);
    },
    releaseWaveProvisionLease: () => Promise.resolve(),
  });
  // Nereikalingas išdavimas kainuotų fencing skaitiklį ir TTL langą.
  assert.equal(provisionCalls, 0);
});

test("išduotas, bet į antrą planą NEPATEKĘS lease ATLAISVINAMAS", async () => {
  const released: SlotProvisionTarget[] = [];
  await planWavePool({
    runId: "r1",
    current: wavePlan(),
    requestedWorkers: 2,
    primaryClaimSupported: false,
    now: () => "2026-08-21T12:00:00.000Z",
    log: () => Promise.resolve(),
    recordEvent: () => Promise.resolve(),
    readIsolationInputs: () => Promise.resolve({ leases: [] }),
    // Kandidatų nėra, tad antras planas slot'ų neturi — išduotas lease lieka nepanaudotas.
    toWorkerCandidates: () => [],
    rememberCandidate: () => {},
    provisionMissingSlotLeases: () => Promise.resolve([{ task_id: "0002", worker_index: 2 }]),
    releaseWaveProvisionLease: (target) => {
      released.push(target);
      return Promise.resolve();
    },
  });
  // Be šio atlaisvinimo lease tris valandas (TTL) blokuotų to task'o dispatch'ą.
  assert.deepEqual(released, [{ task_id: "0002", worker_index: 2 }]);
});

test("perplanavimas VIENKARTINIS: antras išdavimas nebekviečiamas", async () => {
  let provisionCalls = 0;
  await planWavePool({
    runId: "r1",
    current: wavePlan(),
    requestedWorkers: 2,
    primaryClaimSupported: false,
    now: () => "2026-08-21T12:00:00.000Z",
    log: () => Promise.resolve(),
    recordEvent: () => Promise.resolve(),
    readIsolationInputs: () => Promise.resolve({ leases: [] }),
    toWorkerCandidates: () => [],
    rememberCandidate: () => {},
    provisionMissingSlotLeases: () => {
      provisionCalls += 1;
      return Promise.resolve([{ task_id: "0002", worker_index: 2 }]);
    },
    releaseWaveProvisionLease: () => Promise.resolve(),
  });
  // Ciklas „planuok, išduok, perplanuok" be ribos sukiotųsi tol, kol lease'ai baigtųsi.
  assert.equal(provisionCalls, 1);
});
