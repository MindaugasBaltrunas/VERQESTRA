// VQ-502 (4/6-b) testai — package/lockfile ir migracijų guard'ai. Svarbiausia, ką jie
// pin'ina: reason/approval reikalaujama TIK šios sesijos pakeitimams, revertintas failas
// (be pending diff) vartų nekelia, svetimas lockfile blokuoja, o destruktyvi migracija
// praeina TIK su eksplicitiniu patvirtinimu ir lieka pažymėta žurnale.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  evaluateMigrationGuard,
  evaluatePackageGuard,
  type PackageGuardEvidence,
} from "../domain/policies/index.js";
import type { HookFsPort, HookIo } from "../interfaces/hooks/protocol.js";
import { hookPackageGuard, type PackageGuardPorts } from "../interfaces/hooks/package-guard.js";
import { hookMigrationGuard, type MigrationGuardPorts } from "../interfaces/hooks/migration-guard.js";

const ROOT = path.resolve("/repo");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const norm = (value: string): string => value.replace(/\\/g, "/");
const rel = (absolute: string): string => norm(path.relative(ROOT, absolute));
const NOW = new Date("2026-08-21T00:00:00.000Z");

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
// domain: package guard
// ---------------------------------------------------------------------------

function packageEvidence(overrides: Partial<PackageGuardEvidence> = {}): PackageGuardEvidence {
  return {
    isNodeTarget: true,
    targetManager: "pnpm",
    changed: [],
    sessionWrites: [],
    foreignLockfilesOnDisk: [],
    commitMessage: "",
    packageDiffLines: [],
    ...overrides,
  };
}

test("evaluatePackageGuard: šios sesijos package.json be Package reason blokuojamas", () => {
  const blocked = evaluatePackageGuard(
    packageEvidence({ changed: [{ status: " M", file: "package.json" }], sessionWrites: ["package.json"] }),
  );
  assert.equal(blocked.block?.reason, "PACKAGE GUARD BLOKUOTAS — trūksta Package reason");

  const withReason = evaluatePackageGuard(
    packageEvidence({
      changed: [{ status: " M", file: "package.json" }],
      sessionWrites: ["package.json"],
      commitMessage: "feat: x\n\nPackage reason: reikia naujo parserio\n",
    }),
  );
  assert.equal(withReason.block, undefined);
});

test("evaluatePackageGuard: svetimos sesijos pakeitimas nereikalauja priežasties, tik pastabos", () => {
  const verdict = evaluatePackageGuard(packageEvidence({ changed: [{ status: " M", file: "package.json" }] }));
  assert.equal(verdict.block, undefined);
  assert.ok(verdict.notes.some((note) => note.includes("ne šios sesijos")));
  assert.ok(verdict.lines.some((line) => line.includes("(ne šios sesijos)")));
});

test("evaluatePackageGuard: revertintas failas (tuščias status) vartų nekelia", () => {
  // changes.log įrašas be pending git diff — failas sutampa su HEAD.
  const verdict = evaluatePackageGuard(
    packageEvidence({ changed: [{ status: "", file: "package.json" }], sessionWrites: ["package.json"] }),
  );
  assert.equal(verdict.block, undefined);
  assert.ok(verdict.lines.some((line) => line.includes("revertintas/commit'intas")));
});

test("evaluatePackageGuard: lockfile be package.json blokuoja, bet naujas workspace paketas pateisina", () => {
  const lonely = evaluatePackageGuard(
    packageEvidence({ changed: [{ status: " M", file: "pnpm-lock.yaml" }], sessionWrites: ["pnpm-lock.yaml"] }),
  );
  assert.equal(lonely.block?.reason, "PACKAGE GUARD BLOKUOTAS — lockfile keistas be package.json");

  const withNewPackage = evaluatePackageGuard(
    packageEvidence({
      changed: [
        { status: " M", file: "pnpm-lock.yaml" },
        { status: "??", file: "apps/new/package.json" },
      ],
      sessionWrites: ["pnpm-lock.yaml"],
    }),
  );
  assert.equal(withNewPackage.block, undefined);
});

test("evaluatePackageGuard: svetimas lockfile blokuoja, jo TRYNIMAS — ne", () => {
  const changedForeign = evaluatePackageGuard(
    packageEvidence({ changed: [{ status: " M", file: "package-lock.json" }] }),
  );
  assert.equal(changedForeign.block?.reason, "PACKAGE GUARD BLOKUOTAS — aptiktas svetimas lockfile");

  const deletedForeign = evaluatePackageGuard(
    packageEvidence({ changed: [{ status: "D", file: "package-lock.json" }] }),
  );
  assert.equal(deletedForeign.block, undefined, "svetimo lockfile'o šalinimas yra teisingas veiksmas");

  const onDisk = evaluatePackageGuard(packageEvidence({ foreignLockfilesOnDisk: ["yarn.lock"] }));
  assert.equal(onDisk.block?.reason, "PACKAGE GUARD BLOKUOTAS — aptiktas svetimas lockfile");

  // Ne-Node projekte lockfile taisyklės apskritai netaikomos (task 886).
  const nonNode = evaluatePackageGuard(
    packageEvidence({ isNodeTarget: false, targetManager: undefined, changed: [{ status: " M", file: "package-lock.json" }] }),
  );
  assert.equal(nonNode.block, undefined);
  assert.ok(nonNode.lines[0]?.includes("ne-Node projektas"));
});

test("evaluatePackageGuard: didelė priklausomybė be patvirtinimo blokuoja", () => {
  const evidence = packageEvidence({
    changed: [{ status: " M", file: "package.json" }],
    sessionWrites: ["package.json"],
    commitMessage: "feat: x\n\nPackage reason: reikia grafiku\n",
    packageDiffLines: ['+    "recharts": "^2.0.0"'],
  });

  assert.equal(evaluatePackageGuard(evidence).block?.reason, "PACKAGE GUARD BLOKUOTAS — didelė priklausomybė be patvirtinimo");
  assert.equal(
    evaluatePackageGuard({
      ...evidence,
      commitMessage: `${evidence.commitMessage}\nLarge dependency approved: grafikai yra produkto branduolys\n`,
    }).block,
    undefined,
  );
});

// ---------------------------------------------------------------------------
// domain: migration guard
// ---------------------------------------------------------------------------

test("evaluateMigrationGuard: destruktyvus SQL blokuoja, su Migration approved — praeina ir lieka pažymėtas", () => {
  const evidence = {
    changed: [{ status: " M", file: "db/migrations/002_drop.sql" }],
    contents: { "db/migrations/002_drop.sql": "DROP TABLE users;\n" },
    stagedNameStatusLines: [],
    packageDiffLines: [],
    commitMessage: "",
  };

  const blocked = evaluateMigrationGuard(evidence);
  assert.equal(blocked.block?.reason, "MIGRATION GUARD BLOKUOTAS — destruktyvus migracijos pakeitimas be patvirtinimo");
  assert.equal(blocked.destructive, true);

  const approved = evaluateMigrationGuard({
    ...evidence,
    commitMessage: "chore: schema\n\nMigration approved: sutarta su duomenu komanda\n",
  });
  assert.equal(approved.block, undefined);
  // Patvirtintas destruktyvus veiksmas lieka `destructive: true` — kvietėjas privalo tai
  // pažymėti žurnale, kitaip audito pėdsako nebūtų.
  assert.equal(approved.destructive, true);
  assert.equal(approved.approved, true);
});

test("evaluateMigrationGuard: DELETE be WHERE blokuoja, su WHERE — ne; schemos keitimas tik SENSITIVE", () => {
  const unsafe = evaluateMigrationGuard({
    changed: [{ status: " M", file: "db/migrations/003.sql" }],
    contents: { "db/migrations/003.sql": "DELETE FROM sessions;\n" },
    stagedNameStatusLines: [],
    packageDiffLines: [],
    commitMessage: "",
  });
  assert.equal(unsafe.destructive, true);

  const safe = evaluateMigrationGuard({
    changed: [{ status: " M", file: "db/migrations/003.sql" }],
    contents: { "db/migrations/003.sql": "DELETE FROM sessions WHERE expired = true;\nALTER TABLE users ADD COLUMN x int;\n" },
    stagedNameStatusLines: [],
    packageDiffLines: [],
    commitMessage: "",
  });
  assert.equal(safe.destructive, false);
  assert.equal(safe.block, undefined);
  assert.ok(safe.lines.some((line) => line.startsWith("SENSITIVE:")));
});

test("evaluateMigrationGuard: staged trynimas ir knex rollback scriptas blokuoja net be failų pakeitimų", () => {
  const staged = evaluateMigrationGuard({
    changed: [],
    contents: {},
    stagedNameStatusLines: ["D\tdb/migrations/001_init.sql"],
    packageDiffLines: [],
    commitMessage: "",
  });
  assert.equal(staged.migrationChanged, true);
  assert.equal(staged.block?.reason, "MIGRATION GUARD BLOKUOTAS — destruktyvus migracijos pakeitimas be patvirtinimo");

  const rollback = evaluateMigrationGuard({
    changed: [],
    contents: {},
    stagedNameStatusLines: [],
    packageDiffLines: ['+    "db:reset": "knex migrate rollback --all"'],
    commitMessage: "",
  });
  assert.equal(rollback.destructive, true);

  const untouched = evaluateMigrationGuard({
    changed: [{ status: " M", file: "src/a.ts" }],
    contents: {},
    stagedNameStatusLines: [],
    packageDiffLines: [],
    commitMessage: "",
  });
  assert.equal(untouched.migrationChanged, false);
});

// ---------------------------------------------------------------------------
// hooks: adapteriai
// ---------------------------------------------------------------------------

function packagePorts(
  fs: HookFsPort,
  input: { changed?: Array<{ status: string; file: string }>; diff?: string[]; isRepo?: boolean } = {},
): PackageGuardPorts {
  return {
    fs,
    collectChangedFilesWithStatus: async () => input.changed ?? [],
    loadProjectProfile: async () => ({ package_manager: "pnpm", language: "typescript" }),
    isGitRepository: async () => input.isRepo ?? true,
    packageJsonDiffLines: async () => input.diff ?? [],
    now: () => NOW,
  };
}

test("hookPackageGuard: blokada rašo guard žurnalą, pastabą ir grąžina 1", async () => {
  const world = fakeFs({ "package.json": '{ "packageManager": "pnpm@9.0.0" }' });
  const ports = packagePorts(world.fs, { changed: [{ status: " M", file: "package.json" }] });
  const { io, err } = captureIo();

  const exit = await hookPackageGuard({ ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io });
  // Be session-writes ledger'io pakeitimas nėra „šios sesijos" — reason netaikomas, praeina.
  assert.equal(exit, 0);
  assert.match(world.store.get("vq/logs/package-guard.log") ?? "", /package\.json changed/);
  assert.match(world.store.get("vq/logs/hooks.log") ?? "", /ne šios sesijos/);

  const owned = fakeFs({
    "package.json": '{ "packageManager": "pnpm@9.0.0" }',
    "vq/state/session-writes.json": JSON.stringify(["package.json"]),
  });
  const ownedExit = await hookPackageGuard({
    ports: packagePorts(owned.fs, { changed: [{ status: " M", file: "package.json" }] }),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io,
  });
  assert.equal(ownedExit, 1);
  assert.match(err.at(-2) ?? "", /reikia aiškios priežasties/);
});

test("hookPackageGuard: ĮRODYTAI svetimas package.json nebelaiko šios sesijos įkaitu", async () => {
  // 2026-08-24 radinys. `session-writes.json` yra VIENAS failas visai darbo kopijai, tad
  // lygiagrečios sesijos rašymai patenka į tą patį sąrašą. Guard'as iš to darė išvadą „rašė ši
  // sesija" ir reikalaudavo `Package reason` iš to, kas pakeitimo NEDARĖ — būtent tai draudžia
  // `domain/policies/package-guard` antraštė: „viena sesija galėtų amžinai laikyti kitą įkaitu".
  const files = {
    "package.json": '{ "packageManager": "pnpm@9.0.0" }',
    "vq/state/session-writes.json": JSON.stringify(["package.json", "src/mine.ts"]),
    "vq/state/session-write-owners.json": JSON.stringify({
      "package.json": { sessions: ["session:kita"], tasks: [] },
      "src/mine.ts": { sessions: ["session:mano"], tasks: [] },
    }),
  };

  const foreign = fakeFs(files);
  const foreignExit = await hookPackageGuard({
    ports: {
      ...packagePorts(foreign.fs, { changed: [{ status: " M", file: "package.json" }] }),
      env: (name) => (name === "AG_SESSION_ID" ? "mano" : undefined),
    },
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io: captureIo().io,
  });
  assert.equal(foreignExit, 0, "svetimas pakeitimas Stop hook'o neblokuoja");
  assert.match(foreign.store.get("vq/logs/hooks.log") ?? "", /ne šios sesijos/);

  // Ta pati būsena, bet savininkas — MES: vartai privalo likti tokie patys, kokie buvo. Be šio
  // tvirtinimo pataisymas būtų neatskiriamas nuo varto išjungimo.
  const owned = fakeFs(files);
  const ownedExit = await hookPackageGuard({
    ports: {
      ...packagePorts(owned.fs, { changed: [{ status: " M", file: "package.json" }] }),
      env: (name) => (name === "AG_SESSION_ID" ? "kita" : undefined),
    },
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io: captureIo().io,
  });
  assert.equal(ownedExit, 1, "savo pakeitimui reason vartai tebegalioja");

  // Nežinoma tapatybė (be `AG_SESSION_ID`) NIEKO nemeta: „nežinau, kas aš" negali tapti
  // „žinau, kad ne aš" — kitaip guard'as tyliai atsidarytų kiekvienam, kas neperduoda tapatybės.
  const unknown = fakeFs(files);
  const unknownExit = await hookPackageGuard({
    ports: { ...packagePorts(unknown.fs, { changed: [{ status: " M", file: "package.json" }] }), env: () => undefined },
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io: captureIo().io,
  });
  assert.equal(unknownExit, 1, "be tapatybės elgesys lieka toks, koks buvo");
});

test("hookPackageGuard: sugadintas ledger'is nepaverčia pakeitimo šios sesijos darbu", async () => {
  const world = fakeFs({
    "package.json": "{}",
    "vq/state/session-writes.json": "{ broken",
  });
  const { io } = captureIo();
  const exit = await hookPackageGuard({
    ports: packagePorts(world.fs, { changed: [{ status: " M", file: "package.json" }] }),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io,
  });
  // Guard'as neblokuoja dėl savo pačios telemetrijos gedimo.
  assert.equal(exit, 0);
});

function migrationPorts(
  fs: HookFsPort,
  input: { changed?: Array<{ status: string; file: string }>; staged?: string[]; isRepo?: boolean } = {},
): MigrationGuardPorts {
  return {
    fs,
    collectChangedFilesWithStatus: async () => input.changed ?? [],
    isGitRepository: async () => input.isRepo ?? true,
    stagedNameStatusLines: async () => input.staged ?? [],
    packageJsonDiffLines: async () => [],
    now: () => NOW,
  };
}

test("hookMigrationGuard: destruktyvi migracija blokuoja; patvirtinta praeina su audito eilute", async () => {
  const files = { "db/migrations/002.sql": "DROP TABLE users;\n" };

  const blocked = fakeFs(files);
  const { io, err } = captureIo();
  assert.equal(
    await hookMigrationGuard({
      ports: migrationPorts(blocked.fs, { changed: [{ status: " M", file: "db/migrations/002.sql" }] }),
      projectRoot: ROOT,
      runtimeRoot: RUNTIME_ROOT,
      io,
    }),
    1,
  );
  assert.match(blocked.store.get("vq/logs/migration-guard.log") ?? "", /BLOCK: .*destructive SQL/);
  assert.match(err[0] ?? "", /destruktyvu DB migracijos pakeitima/);

  const approved = fakeFs({
    ...files,
    "vq/logs/commit-msg.md": "chore: schema\n\nMigration approved: sutarta su duomenu komanda\n",
  });
  assert.equal(
    await hookMigrationGuard({
      ports: migrationPorts(approved.fs, { changed: [{ status: " M", file: "db/migrations/002.sql" }] }),
      projectRoot: ROOT,
      runtimeRoot: RUNTIME_ROOT,
      io: captureIo().io,
    }),
    0,
  );
  assert.match(approved.store.get("vq/logs/hooks.log") ?? "", /leistas su Migration approved/);
});

test("hookMigrationGuard: be migracijų žurnalas vis tiek rašomas su skip eilute", async () => {
  const world = fakeFs({ "src/a.ts": "x\n" });
  const { io } = captureIo();
  const exit = await hookMigrationGuard({
    ports: migrationPorts(world.fs, { changed: [{ status: " M", file: "src/a.ts" }] }),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io,
  });

  assert.equal(exit, 0);
  assert.equal(world.store.get("vq/logs/migration-guard.log"), "", "žurnalas rašomas net tuščias");
  assert.match(world.store.get("vq/logs/hooks.log") ?? "", /Migration guard praleistas/);
});
