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
import type { SchedulingFileSystemPort } from "../application/scheduling/ports.js";
import type { WorktreeProvisionOutcome } from "../application/scheduling/wave-provisioning.js";

const ROOT = "D:/repo";
const NOW = "2026-08-23T12:00:00.000Z";
const TARGET = { worker_index: 1, task_id: "0042", file: "AG/tasks/queue/0042.md" };

function memoryFs(): SchedulingFileSystemPort {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const norm = (value: string): string => value.replace(/\\/g, "/");
  const port: SchedulingFileSystemPort = {
    readTextFileIfExists: async (p) => files.get(norm(p)),
    listDirectoryIfExists: async (dir) => {
      const prefix = `${norm(dir)}/`;
      const names = [...files.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .filter((name) => !name.includes("/"));
      return names.length === 0 && !dirs.has(norm(dir)) ? undefined : names;
    },
    writeTextFileAtomic: async (p, content) => {
      files.set(norm(p), content);
    },
    makeDirectory: async (dir) => {
      dirs.add(norm(dir));
    },
    exists: async (p) => files.has(norm(p)) || dirs.has(norm(p)),
    createLockDirectory: async (dir) => {
      const key = norm(dir);
      if (dirs.has(key)) return "exists";
      dirs.add(key);
      return "created";
    },
    removeDirectory: async (dir) => {
      dirs.delete(norm(dir));
    },
    directoryModifiedAtMs: async (dir) => (dirs.has(norm(dir)) ? Date.parse(NOW) : undefined),
  };
  return port;
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

test("aprūpinimo išimtis nepalieka aktyvaus lease", async () => {
  const result = await provisionWith(() => Promise.reject(new Error("git nulūžo")));
  assert.ok(
    result.logs.some((line) => line.includes("SLOT PROVISION FAILED")),
    "aprūpinimas NIEKADA nemeta — nesėkmė lieka žurnale",
  );
  assert.equal(result.held, 0, `išimtis privalo grąžinti lease; log:\n  ${result.logs.join("\n  ")}`);
});
