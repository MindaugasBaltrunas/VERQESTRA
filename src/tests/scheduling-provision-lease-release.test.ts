// 2026-08-23 (operatoriaus radinys, P1): worktree sukūrimo klaida palikdavo AKTYVŲ worker lease.
//
// Lease imamas PRIEŠ `worktree.create`, bet `quarantined`, infrastruktūros klaidos ir išimties
// keliai grįždavo `false` jo neatlaisvinę. Bendras pool'o valymas jo nemato, nes nepavykęs slot'as
// į `provisioned` nepatenka — worker'is likdavo užimtas iki TTL, t. y. iki trijų valandų.
//
// Testas tikrina per TIKRĄ lease saugyklą (atmintyje laikomas `SchedulingFileSystemPort`), o ne per
// log eilutes: svarbu ne pranešimas, o tai, ar `held` lease liko diske.
import assert from "node:assert/strict";
import test from "node:test";
import { createWaveProvisioningCoordinator } from "../application/scheduling/wave-provisioning.js";
import { listWorkerLeases } from "../application/scheduling/worker-lease-store.js";
import { leaseGuardsTask, type WorkerLease } from "../domain/scheduling/worker-lease-rules.js";
import type { SchedulingFileSystemPort } from "../application/scheduling/ports.js";
import type { WorktreeProvisionOutcome } from "../application/scheduling/wave-provisioning.js";
import { memorySchedulingFs } from "./helpers/memory-scheduling-fs.js";

const ROOT = "D:/repo";
const NOW = "2026-08-23T12:00:00.000Z";
const TARGET = { worker_index: 1, task_id: "0042", file: "AG/tasks/queue/0042.md" };

function memoryFs(): SchedulingFileSystemPort {
  return memorySchedulingFs(Date.parse(NOW)).port;
}

async function provisionWith(create: () => Promise<WorktreeProvisionOutcome>): Promise<{ held: number; logs: string[] }> {
  const fs = memoryFs();
  const logs: string[] = [];

  const coordinator = createWaveProvisioningCoordinator({
    workspaceRoot: ROOT,
    runId: "r1",
    ownerId: "pid-1",
    leaseStore: { fs },
    worktree: {
      policyEnabled: () => Promise.resolve(true),
      rootIsIgnored: () => Promise.resolve(true),
      create,
    },
    now: () => NOW,
    log: (line: string) => {
      logs.push(line);
      return Promise.resolve();
    },
    graph: () => undefined,
    running: () => new Set<string>(),
  } as never);

  const provisioned = await coordinator.provisionSlotLease(TARGET);
  assert.equal(provisioned, false, "nesėkmingas aprūpinimas slot'o neišduoda");

  const leases = await listWorkerLeases(fs, ROOT);
  // Be šio teiginio „0 held" būtų tuščias: jis būtų teisingas ir tada, jei lease apskritai nebūtų
  // buvęs paimtas (pvz. sulūžus fixture'ui). Atlaisvinimo eilutė įrodo, kad lease BUVO ir dingo.
  assert.ok(
    logs.some((line) => line.includes("SLOT LEASE RELEASE")),
    `laukta atlaisvinimo eilutės — be jos testas nieko neįrodo; log:\n  ${logs.join("\n  ")}`,
  );
  return { held: leases.filter((lease) => lease.status === "held").length, logs };
}

test("worktree karantinas nepalieka aktyvaus lease", async () => {
  const result = await provisionWith(() => Promise.resolve({ status: "quarantined", reason: "nešvari kopija" } as never));
  assert.equal(result.held, 0, `karantinas privalo grąžinti lease; log:\n  ${result.logs.join("\n  ")}`);
});

test("worktree infrastruktūros klaida nepalieka aktyvaus lease", async () => {
  const result = await provisionWith(() => Promise.resolve({ status: "infrastructure", message: "git nulūžo" } as never));
  assert.equal(result.held, 0, `infrastruktūros klaida privalo grąžinti lease; log:\n  ${result.logs.join("\n  ")}`);
});

// 2026-08-24 (operatoriaus radinys): trys testai aukščiau krenta PRIEŠ worktree sukūrimą, tad nė
// vienas jų nedengė kelio, kuriame kopija JAU egzistuoja. Ten atsakymas priešingas: lease privalo
// LIKTI. `held` iki tol būdavo `acquired.lease` be `worktree_path`, tad sargas „už lease'o stovi
// kopija" skaitydavo pasenusią reikšmę ir lease būdavo atlaisvinamas — o kitas bandymas su NAUJU
// claim'u tą pačią kopiją klasifikuodavo kaip `foreign-owner` ir siųsdavo į karantiną.
test("metaduomenų rašymo klaida PO sėkmingo worktree PALIEKA lease kopijai", async () => {
  const fs = memoryFs();
  const logs: string[] = [];
  const write = fs.writeTextFileAtomic.bind(fs);
  let leaseWrites = 0;

  const failingFs: SchedulingFileSystemPort = {
    ...fs,
    writeTextFileAtomic: async (p, content) => {
      // Pirmas rašymas — lease'o paėmimas; antras — metaduomenys su `worktree_path`.
      if (content.includes("worktree_path")) {
        leaseWrites += 1;
        throw new Error("disk full");
      }
      await write(p, content);
    },
  };

  const coordinator = createWaveProvisioningCoordinator({
    workspaceRoot: ROOT,
    runId: "r1",
    ownerId: "pid-1",
    leaseStore: { fs: failingFs },
    worktree: {
      policyEnabled: () => Promise.resolve(true),
      rootIsIgnored: () => Promise.resolve(true),
      // Kopija sukuriama SĖKMINGAI — nuo čia ji egzistuoja diske su savo owner žyma.
      create: () => Promise.resolve({ status: "created", relativePath: ".ag/worktrees/w1" } as never),
    },
    now: () => NOW,
    log: (line: string) => {
      logs.push(line);
      return Promise.resolve();
    },
    graph: () => undefined,
    running: () => new Set<string>(),
  } as never);

  assert.equal(await coordinator.provisionSlotLease(TARGET), false, "slot'as neišduodamas");
  assert.equal(leaseWrites, 1, "metaduomenų rašymas tikrai buvo bandytas");

  const leases = await listWorkerLeases(failingFs, ROOT);
  assert.equal(
    leases.filter((lease) => lease.status === "held").length,
    1,
    `lease privalo likti prie gyvos kopijos; log:\n  ${logs.join("\n  ")}`,
  );
  assert.ok(
    logs.some((line) => line.includes("SLOT LEASE KEPT")),
    `laukta „KEPT" eilutės — be jos neaišku, ar lease liko sąmoningai; log:\n  ${logs.join("\n  ")}`,
  );
});

test("aprūpinimo išimtis nepalieka aktyvaus lease", async () => {
  const result = await provisionWith(() => Promise.reject(new Error("git nulūžo")));
  assert.ok(
    result.logs.some((line) => line.includes("SLOT PROVISION FAILED")),
    "aprūpinimas NIEKADA nemeta — nesėkmė lieka žurnale",
  );
  assert.equal(result.held, 0, `išimtis privalo grąžinti lease; log:\n  ${result.logs.join("\n  ")}`);
});

// ---------------------------------------------------------------------------
// leaseGuardsTask — ar task'as VYKDOMAS dabar (2026-08-25 dvigubos aktyvacijos incidentas)
// ---------------------------------------------------------------------------

const GUARD_NOW = new Date("2026-08-23T12:00:00.000Z");
const ALIVE = (): boolean => true;
const DEAD = (): boolean => false;

function leaseFixture(overrides: Partial<WorkerLease> = {}): WorkerLease {
  return {
    schema_version: 1,
    lease_id: "lease-1",
    owner_id: "loop-4242",
    run_id: "run-1",
    worker_id: "w1",
    task_id: "0042",
    attempt: 1,
    status: "held",
    fencing_token: 1,
    acquired_at: "2026-08-23T11:00:00.000Z",
    heartbeat_at: "2026-08-23T11:59:00.000Z",
    expires_at: "2026-08-23T13:00:00.000Z",
    ...overrides,
  };
}

test("leaseGuardsTask: held + nepasibaigęs + gyvas savininkas = task'as VYKDOMAS", () => {
  assert.equal(leaseGuardsTask(leaseFixture(), GUARD_NOW, ALIVE), true);
});

test("leaseGuardsTask: pasibaigęs TTL arba miręs savininkas atlaisvina task'ą atstatymui", () => {
  const expired = leaseFixture({ expires_at: "2026-08-23T11:30:00.000Z" });
  assert.equal(leaseGuardsTask(expired, GUARD_NOW, ALIVE), false, "TTL pasibaigęs");

  assert.equal(leaseGuardsTask(leaseFixture(), GUARD_NOW, DEAD), false, "savininko procesas miręs");

  const released = leaseFixture({ status: "released" });
  assert.equal(leaseGuardsTask(released, GUARD_NOW, ALIVE), false, "lease atlaisvintas");
});

test("leaseGuardsTask: FAIL-CLOSED abiem kryptim", () => {
  // Neperskaitomas `expires_at` laikomas pasibaigusiu — sugadintas lease neužrakina task'o amžiams.
  const broken = leaseFixture({ expires_at: "ne-data" });
  assert.equal(leaseGuardsTask(broken, GUARD_NOW, ALIVE), false);

  // Neatpažinta savininko forma gyvumo klausimo NEATSAKO, tad lease lieka galioti: nežinojimas
  // apie svetimą savininką nesuteikia teisės perimti jo task'o.
  const foreignOwner = leaseFixture({ owner_id: "ui-session-7" });
  assert.equal(leaseGuardsTask(foreignOwner, GUARD_NOW, DEAD), true);
});
