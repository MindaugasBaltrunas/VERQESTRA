// VQ-504 (42/N) testai — bangos įvestys ir pool'o perplanavimas.
//
// Kertinės savybės: efektyvus slot'ų skaičius yra PREFIKSAS (ne kiekis), o pool'o perplanavimas
// atlaisvina kiekvieną išduotą, bet nepanaudotą lease'ą — kitaip jis tris valandas blokuotų
// task'o dispatch'ą.

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWorkerRequest, runnableSlotPrefix } from "../application/scheduling/wave-inputs.js";
import { planWavePool, type SlotProvisionTarget } from "../application/scheduling/wave-pool-planning.js";
import { computeTaskWriteSet } from "../application/scheduling/conflict-detector.js";
import type { WorkerCandidate } from "../application/scheduling/worker-pool-admission.js";
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
    decision_hash: "dh1:test",
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
      return Promise.resolve({ provisioned: [], lastOutcomeByTask: new Map() });
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
    provisionMissingSlotLeases: () =>
      Promise.resolve({ provisioned: [{ task_id: "0002", worker_index: 2 }], lastOutcomeByTask: new Map() }),
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
      return Promise.resolve({ provisioned: [{ task_id: "0002", worker_index: 2 }], lastOutcomeByTask: new Map() });
    },
    releaseWaveProvisionLease: () => Promise.resolve(),
  });
  // Ciklas „planuok, išduok, perplanuok" be ribos sukiotųsi tol, kol lease'ai baigtųsi.
  assert.equal(provisionCalls, 1);
});

function determinateCandidates(): WorkerCandidate[] {
  return [
    { task_id: "0001", file: "AG/tasks/queue/0001.md", write_set: computeTaskWriteSet({ task_id: "0001", allowed_paths: ["src/a.ts"] }) },
    { task_id: "0002", file: "AG/tasks/queue/0002.md", write_set: computeTaskWriteSet({ task_id: "0002", allowed_paths: ["src/b.ts"] }) },
  ];
}

// 116 (2026-09-01, W1/w2 slot'ų auditas P3): `missing-lease` atmetimas be konteksto siunčia
// operatorių ieškoti lease'ų, nors provisionMissingSlotLeases jau žino TIKRĄJĄ priežastį (šiuo
// atveju — gitignore'inta šaknis). Pool eilutė tą priežastį privalo įpinti.
test("WORKER POOL eilutė missing-lease įrašui prideda paskutinę provision baigtį", async () => {
  const logs: string[] = [];
  await planWavePool({
    runId: "r1",
    current: wavePlan(),
    requestedWorkers: 2,
    primaryClaimSupported: false,
    now: () => "2026-08-21T12:00:00.000Z",
    log: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    recordEvent: () => Promise.resolve(),
    readIsolationInputs: () => Promise.resolve({ leases: [] }),
    toWorkerCandidates: () => determinateCandidates(),
    rememberCandidate: () => {},
    provisionMissingSlotLeases: () =>
      Promise.resolve({
        provisioned: [],
        lastOutcomeByTask: new Map([["0002", "worktree šaknis nėra gitignore'inta"]]),
      }),
    releaseWaveProvisionLease: () => Promise.resolve(),
  });

  const line = logs.find((entry) => entry.startsWith("WORKER POOL:"));
  assert.ok(line !== undefined, "pool eilutė turi būti parašyta");
  assert.ok(line?.includes("0002: missing-lease"), "bazinė priežastis lieka");
  assert.ok(
    line?.includes("paskutinis provision bandymas: worktree šaknis nėra gitignore'inta"),
    "TIKROJI priežastis matoma toje pačioje eilutėje",
  );
});

// Be provision bandymo (lastOutcomeByTask tuščias) eilutė nekinta — praturtinimas nepridedamas,
// jei nėra ką pridėti.
test("missing-lease BE provision bandymo — eilutė kaip iki šiol", async () => {
  const logs: string[] = [];
  await planWavePool({
    runId: "r1",
    current: wavePlan(),
    requestedWorkers: 2,
    primaryClaimSupported: false,
    now: () => "2026-08-21T12:00:00.000Z",
    log: (message) => {
      logs.push(message);
      return Promise.resolve();
    },
    recordEvent: () => Promise.resolve(),
    readIsolationInputs: () => Promise.resolve({ leases: [] }),
    toWorkerCandidates: () => determinateCandidates(),
    rememberCandidate: () => {},
    provisionMissingSlotLeases: () => Promise.resolve({ provisioned: [], lastOutcomeByTask: new Map() }),
    releaseWaveProvisionLease: () => Promise.resolve(),
  });

  const line = logs.find((entry) => entry.startsWith("WORKER POOL:"));
  assert.ok(line !== undefined);
  assert.ok(line?.includes("0002: missing-lease — antram workeriui reikalingas worker lease"));
  assert.ok(!line?.includes("paskutinis provision bandymas"));
});
