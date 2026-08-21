// VQ-504 (39/N) testai — tuščios eilės sprendimas.
//
// Pin'inama tai, kas šiame sprendime pavojinga: praleistas auditas NIEKADA nevirsta praėjusiu,
// bootstrap bandomas tik kartą, o advisory converge negali pakeisti nei verdikto, nei baigties.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUDIT_REPAIR_TASK_CONTENT,
  BOUNDED_BENCHMARK_CELL_VARIABLE,
  handleEmptyQueue,
  isBoundedBenchmarkCell,
  type EmptyQueuePorts,
  type EmptyQueueWaveResult,
} from "../application/scheduling/loop-empty-queue.js";

const blockedWave: EmptyQueueWaveResult = {
  status: "blocked",
  synthesized: 0,
  blocked: 0,
  done: 0,
  total: 0,
  already_implemented: 0,
  external_satisfied: 0,
  no_evidence: 0,
};

type Recorded = { logs: string[]; out: string[]; calls: string[] };

function ports(
  overrides: Partial<EmptyQueuePorts> = {},
): { ports: EmptyQueuePorts; recorded: Recorded } {
  const recorded: Recorded = { logs: [], out: [], calls: [] };
  const base: EmptyQueuePorts = {
    detectBootstrapEligibility: () => {
      recorded.calls.push("detect");
      return Promise.resolve({ bootstrapEligible: false });
    },
    runBootstrap: () => {
      recorded.calls.push("bootstrap");
      return Promise.resolve({ status: "created", render: "bootstrap ok" });
    },
    resolveModel: () => Promise.resolve("sonnet-x"),
    synthesizeWave: () => {
      recorded.calls.push("wave");
      return Promise.resolve(blockedWave);
    },
    runQualityGates: () => {
      recorded.calls.push("gates");
      return Promise.resolve(0);
    },
    dispatchAuditRepair: () => {
      recorded.calls.push("repair");
      return Promise.resolve();
    },
    runConverge: () => {
      recorded.calls.push("converge");
      return Promise.resolve({ issues: [] });
    },
    log: (message) => {
      recorded.logs.push(message);
      return Promise.resolve();
    },
    out: (message) => recorded.out.push(message),
    env: {},
    ...overrides,
  };
  return { ports: base, recorded };
}

test("isBoundedBenchmarkCell: FAIL-CLOSED link produkcijos", () => {
  for (const value of ["1", "true", "TRUE", " 1 "]) {
    assert.equal(isBoundedBenchmarkCell({ [BOUNDED_BENCHMARK_CELL_VARIABLE]: value }), true, value);
  }
  // Bet kas kita palieka ĮPRASTĄ elgesį: klaidingai įjungta žymė praleistų auditą.
  for (const value of [undefined, "", "0", "false", "yes", "on"]) {
    assert.equal(isBoundedBenchmarkCell({ [BOUNDED_BENCHMARK_CELL_VARIABLE]: value }), false, String(value));
  }
});

test("ribotas narvelis PRALEIDŽIA visus tris žingsnius ir išeina", async () => {
  const world = ports({ env: { [BOUNDED_BENCHMARK_CELL_VARIABLE]: "1" } });
  const action = await handleEmptyQueue(world.ports, "/repo", false);

  assert.equal(action, "exit");
  // Kertinė savybė: audito NEBUVO, tad jis negali būti supainiotas su praėjusiu.
  assert.deepEqual(world.recorded.calls, []);
  assert.equal(world.recorded.logs.some((line) => line.includes("AUDIT PASSED")), false);
});

test("tinkamas bootstrap'as rašo task'us ir loop'as TĘSIASI", async () => {
  const world = ports({ detectBootstrapEligibility: () => Promise.resolve({ bootstrapEligible: true }) });
  const action = await handleEmptyQueue(world.ports, "/repo", false);

  assert.equal(action, "continue");
  assert.ok(world.recorded.calls.includes("bootstrap"));
  // Auditas nepaleidžiamas: eilė gali būti nebe tuščia jau kitą ratą.
  assert.equal(world.recorded.calls.includes("gates"), false);
});

test("jau bandytas bootstrap'as antrą kartą NEBANDOMAS", async () => {
  const world = ports({ detectBootstrapEligibility: () => Promise.resolve({ bootstrapEligible: true }) });
  const action = await handleEmptyQueue(world.ports, "/repo", true);

  // Antras bandymas tame pačiame bėgime reikštų ciklą — netinkamas projektas duotų tą patį atsakymą.
  assert.equal(world.recorded.calls.includes("detect"), false);
  assert.equal(action, "exit");
});

test("sintezuota banga grąžina `continue` be audito", async () => {
  const world = ports({
    synthesizeWave: () =>
      Promise.resolve({ ...blockedWave, status: "synthesized", synthesized: 3, done: 1, total: 4, already_implemented: 2 }),
  });
  const action = await handleEmptyQueue(world.ports, "/repo", true);

  assert.equal(action, "continue");
  assert.equal(world.recorded.calls.includes("gates"), false);
  // Praleisti mazgai MATOMI, o ne nutylimi.
  assert.ok(world.recorded.logs.some((line) => line.includes("skipped-implemented 2")));
});

test("nepavykęs auditas išduoda remonto užduotį", async () => {
  const world = ports({ runQualityGates: () => Promise.resolve(2) });
  const action = await handleEmptyQueue(world.ports, "/repo", true);

  assert.equal(action, "exit");
  assert.ok(world.recorded.calls.includes("repair"));
  assert.ok(world.recorded.logs.some((line) => line.includes("QUALITY-GATES AUDIT FAILED: exit=2")));
  assert.ok(AUDIT_REPAIR_TASK_CONTENT.includes("System Repair Task"));
});

test("converge yra ADVISORY: drift'as nekeičia nei baigties, nei remonto", async () => {
  const world = ports({
    runConverge: () => Promise.resolve({ issues: [{ kind: "missing-task" }, { kind: "missing-task" }, { kind: "stale-status" }] }),
  });
  const action = await handleEmptyQueue(world.ports, "/repo", true);

  assert.equal(action, "exit");
  assert.equal(world.recorded.calls.includes("repair"), false, "advisory patikra remonto neišduoda");
  // Kind'ai rikiuojami abėcėliškai — ta pati būsena visada duoda tą pačią eilutę.
  assert.ok(world.recorded.logs.some((line) => line === "CONVERGE DRIFT: 3 issue(s) — 2 missing-task, 1 stale-status"));
});

test("converge KLAIDA virsta įspėjimu, o žingsnis baigiasi normaliai", async () => {
  const world = ports({ runConverge: () => Promise.reject(new Error("git dingo")) });
  const action = await handleEmptyQueue(world.ports, "/repo", true);

  assert.equal(action, "exit");
  assert.ok(world.recorded.logs.some((line) => line.includes("WARNING: converge advisory check failed: git dingo")));
});

test("net NEĮRAŠOMA advisory eilutė nenutraukia pabaigos", async () => {
  const world = ports({
    log: (message) => (message.startsWith("CONVERGE") ? Promise.reject(new Error("log dingo")) : Promise.resolve()),
  });
  const action = await handleEmptyQueue(world.ports, "/repo", true);

  // Advisory eilutė nėra vartai: jos praradimas negali sulaužyti tuščios eilės žingsnio.
  assert.equal(action, "exit");
  assert.ok(world.recorded.out.some((line) => line.includes("Queue empty: AG/tasks/queue")));
});
