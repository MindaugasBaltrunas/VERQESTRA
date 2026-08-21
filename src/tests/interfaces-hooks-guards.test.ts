// VQ-502 (2/6) testai — guard'ų taisyklės ir jų protokolo pusė: failų klasifikacija (svetimi
// lockfile'ai, package manager pirmumas, skipinami keliai), slaptukų pattern'ai su self-match
// apsauga, eilučių taisyklių variklis, secret-scan fail-closed vartai ir file-line-guard
// skip/block/ok išsišakojimas.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  findSecretsInText,
  hasDisableReason,
  isBackendApiFile,
  isForeignLockfilePath,
  isFrontendReactFile,
  isLockfilePath,
  isMigrationFile,
  isMobileFile,
  isPackageJsonPath,
  matchSecretPattern,
  numberedLine,
  resolveTargetPackageManager,
  scanLineRules,
  shouldSkipSecretScan,
  type LineRule,
} from "../domain/policies/index.js";
import type { HookFsPort, HookIo } from "../interfaces/hooks/protocol.js";
import { hookSecretScan, type SecretScanPorts } from "../interfaces/hooks/secret-scan.js";
import { runFileLineGuard, type FileLineGuardConfig } from "../interfaces/hooks/file-line-guard.js";

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
// domain: failų klasifikacija
// ---------------------------------------------------------------------------

test("shouldSkipSecretScan: runtime, generated ir kredencialų keliai praleidžiami, produkto kodas — ne", () => {
  assert.equal(shouldSkipSecretScan("src/a.ts"), false);
  assert.equal(shouldSkipSecretScan(""), true);
  assert.equal(shouldSkipSecretScan("dist/index.js"), true);
  assert.equal(shouldSkipSecretScan("vq/state/stable-ref"), true);
  assert.equal(shouldSkipSecretScan("vq/logs/hooks.log"), true);
  assert.equal(shouldSkipSecretScan("vq/supervisor/decision.json"), true);
  assert.equal(shouldSkipSecretScan("node_modules/x/index.js"), true);
  assert.equal(shouldSkipSecretScan("pnpm-lock.yaml"), true);
  assert.equal(shouldSkipSecretScan("config/.env.local"), true);
  assert.equal(shouldSkipSecretScan("app/.env"), true);
});

test("lockfile'ai: svetimas tik target valdiklio atžvilgiu, be įrodymų — niekas nesvetimas", () => {
  assert.equal(isLockfilePath("pnpm-lock.yaml"), true);
  assert.equal(isLockfilePath("apps/web/yarn.lock"), true);
  assert.equal(isLockfilePath("node_modules/x/yarn.lock"), false);
  assert.equal(isLockfilePath("src/a.ts"), false);

  assert.equal(isForeignLockfilePath("package-lock.json", "pnpm"), true);
  assert.equal(isForeignLockfilePath("pnpm-lock.yaml", "pnpm"), false);
  // Task 886: be išspręsto valdiklio svetimų lockfile'ų nėra.
  assert.equal(isForeignLockfilePath("package-lock.json", undefined), false);
});

test("resolveTargetPackageManager: profilis > package.json > esamas lockfile'as", () => {
  assert.equal(
    resolveTargetPackageManager({
      profilePackageManager: "yarn",
      packageJsonPackageManager: "pnpm@9.0.0",
      existingRootLockfileManager: "npm",
    }),
    "yarn",
  );
  assert.equal(
    resolveTargetPackageManager({ packageJsonPackageManager: "pnpm@9.15.9", existingRootLockfileManager: "npm" }),
    "pnpm",
  );
  assert.equal(resolveTargetPackageManager({ existingRootLockfileManager: "bun" }), "bun");
  assert.equal(resolveTargetPackageManager({ profilePackageManager: "cargo" }), undefined);
  assert.equal(resolveTargetPackageManager({}), undefined);
});

test("scope klasifikatoriai: package.json, migracijos, frontend/backend/mobile su profilio šaknimis", () => {
  assert.equal(isPackageJsonPath("apps/web/package.json"), true);
  assert.equal(isPackageJsonPath("node_modules/x/package.json"), false);

  assert.equal(isMigrationFile("db/migrations/001_init.sql"), true);
  assert.equal(isMigrationFile("db/002_add.migration.sql"), true);
  assert.equal(isMigrationFile("drizzle.config.ts"), true);
  assert.equal(isMigrationFile("src/a.ts"), false);

  assert.equal(isFrontendReactFile("apps/web/src/App.tsx"), true);
  assert.equal(isFrontendReactFile("apps/web/src/util.ts"), false);
  // Task 888: kitaip pavadintas frontend katalogas irgi klasifikuojamas.
  assert.equal(isFrontendReactFile("frontend/src/App.tsx", "frontend"), true);

  assert.equal(isBackendApiFile("apps/api/src/routes/users.ts"), true);
  assert.equal(isBackendApiFile("apps/api/src/x.service.ts"), true);
  assert.equal(isBackendApiFile("server/src/routes/x.ts", "server"), true);
  assert.equal(isBackendApiFile("apps/api/src/util.ts"), false);

  assert.equal(isMobileFile("apps/mobile/App.tsx"), true);
  assert.equal(isMobileFile("apps/mobile/assets/logo.png"), false);

  assert.equal(hasDisableReason("// eslint-disable-next-line -- reikia dėl X"), true);
  assert.equal(hasDisableReason("// eslint-disable-next-line"), false);
});

// ---------------------------------------------------------------------------
// domain: slaptukų pattern'ai ir eilučių variklis
// ---------------------------------------------------------------------------

test("slaptukų pattern'ai: tikri raktai pagaunami, nekalti identifikatoriai — ne", () => {
  assert.equal(matchSecretPattern("const k = 'AKIA1234567890ABCDEF'")?.name, "aws-access-key");
  assert.equal(matchSecretPattern("token: ghp_abcdefghijklmnopqrstuvwxyz")?.name, "github-token");
  assert.equal(matchSecretPattern("-----BEGIN RSA PRIVATE KEY-----")?.name, "private-key");
  // `\b` prieš sk- saugo nuo false positive įprastuose identifikatoriuose.
  assert.equal(matchSecretPattern("task-classification-policy-file"), undefined);
  assert.equal(matchSecretPattern("const x = 1"), undefined);

  const findings = findSecretsInText("src/a.ts", "line one\nkey = AKIA1234567890ABCDEF\nlast");
  assert.deepEqual(findings, ["src/a.ts:2:possible-secret:aws-access-key"]);
});

test("scanLineRules: visos taisyklės kiekvienai eilutei, blokavimas tik su blocks:true", () => {
  const warn: LineRule = {
    matches: (context) => context.line.includes("TODO"),
    findings: (context) => [`warn:${numberedLine(context)}`],
  };
  const blocker: LineRule = {
    matches: (context) => context.line.includes("any"),
    findings: (context) => [`block:${context.lineNumber}`],
    blocks: true,
  };

  const warnOnly = scanLineRules("a.ts", "TODO fix\nclean", [warn, blocker]);
  assert.deepEqual(warnOnly.findings, ["warn:1:TODO fix"]);
  assert.equal(warnOnly.blocked, false);

  // Ta pati eilutė gali pagauti kelias taisykles — žurnalas rodo abu radinius.
  const both = scanLineRules("a.ts", "TODO any", [warn, blocker]);
  assert.deepEqual(both.findings, ["warn:1:TODO any", "block:1"]);
  assert.equal(both.blocked, true);
});

// ---------------------------------------------------------------------------
// hooks: secret-scan
// ---------------------------------------------------------------------------

function secretPorts(
  fs: HookFsPort,
  input: { changed?: string[]; ignored?: string[]; enabled?: boolean } = {},
): SecretScanPorts {
  return {
    fs,
    collectChangedFiles: async () => input.changed ?? [],
    filterGitIgnored: async () => new Set(input.ignored ?? []),
    secretScanEnabled: async () => input.enabled ?? true,
    now: () => new Date("2026-08-21T00:00:00.000Z"),
  };
}

test("hookSecretScan: radinys blokuoja ir patenka į žurnalą", async () => {
  const world = fakeFs({ "src/a.ts": "key = AKIA1234567890ABCDEF\n" });
  const { io, err } = captureIo();
  const exit = await hookSecretScan({
    ports: secretPorts(world.fs, { changed: ["src/a.ts"] }),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io,
  });

  assert.equal(exit, 1);
  assert.equal(world.store.get("vq/logs/secret-scan.log"), "src/a.ts:1:possible-secret:aws-access-key\n");
  assert.match(world.store.get("vq/logs/hooks.log") ?? "", /SECRET SCAN BLOKUOTAS/);
  assert.match(err[0] ?? "", /rado galimu tokenu/);
});

test("hookSecretScan: gitignored ir skipinami keliai neskenuojami, švarus bėgimas — 0", async () => {
  const world = fakeFs({
    "vq/config/local.env": "AKIA1234567890ABCDEF",
    "vq/state/x.json": "AKIA1234567890ABCDEF",
    "src/clean.ts": "const x = 1\n",
  });
  const { io } = captureIo();
  const exit = await hookSecretScan({
    ports: secretPorts(world.fs, {
      changed: ["vq/config/local.env", "vq/state/x.json", "src/clean.ts"],
      ignored: ["vq/config/local.env"],
    }),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io,
  });

  assert.equal(exit, 0);
  assert.equal(world.store.get("vq/logs/secret-scan.log"), "");
  assert.match(world.store.get("vq/logs/hooks.log") ?? "", /slaptukų nerasta/);
});

test("hookSecretScan: politika išjungia skenavimą TIK aiškiu false", async () => {
  const world = fakeFs({ "src/a.ts": "key = AKIA1234567890ABCDEF\n" });
  const { io } = captureIo();
  const exit = await hookSecretScan({
    ports: secretPorts(world.fs, { changed: ["src/a.ts"], enabled: false }),
    projectRoot: ROOT,
    runtimeRoot: RUNTIME_ROOT,
    io,
  });

  assert.equal(exit, 0);
  assert.match(world.store.get("vq/logs/hooks.log") ?? "", /no_secrets_in_repo=false/);
  assert.equal(world.store.get("vq/logs/secret-scan.log"), "", "praleistas skenavimas nepalieka senų radinių");
});

// ---------------------------------------------------------------------------
// hooks: file-line-guard
// ---------------------------------------------------------------------------

const BLOCK_ANY: LineRule = {
  matches: (context) => context.line.includes("any"),
  findings: (context) => [`no-any:${context.lineNumber}`],
  blocks: true,
};

function guardConfig(overrides: Partial<FileLineGuardConfig> = {}): FileLineGuardConfig {
  return {
    guardLog: "frontend-guard.log",
    classify: (file) => file.endsWith(".tsx"),
    rules: [BLOCK_ANY],
    messages: {
      skip: "Frontend guard SKIP — nėra pakeistų .tsx failų",
      blocked: "FRONTEND GUARD BLOKUOTAS",
      blockedConsole: ["Frontend guard rado pažeidimų."],
      ok: "Frontend guard ✅",
    },
    ...overrides,
  };
}

test("runFileLineGuard: nėra apimties failų — žurnale `skipped:`, ne tuščias failas", async () => {
  const world = fakeFs({ "src/a.ts": "const x = 1\n" });
  const { io } = captureIo();
  const exit = await runFileLineGuard(
    {
      ports: { fs: world.fs, collectChangedFiles: async () => ["src/a.ts"], now: () => new Date(0) },
      projectRoot: ROOT,
      runtimeRoot: RUNTIME_ROOT,
      io,
    },
    "post",
    guardConfig(),
  );

  assert.equal(exit, 0);
  assert.match(world.store.get("vq/logs/frontend-guard.log") ?? "", /^skipped: Frontend guard SKIP/);
});

test("runFileLineGuard: blokuojanti taisyklė — 1, radiniai žurnale, stopStep nekviečiamas", async () => {
  const world = fakeFs({ "apps/web/src/App.tsx": "const x: any = 1\n" });
  let stopSteps = 0;
  const { io, err } = captureIo();
  const exit = await runFileLineGuard(
    {
      ports: { fs: world.fs, collectChangedFiles: async () => ["apps/web/src/App.tsx"], now: () => new Date(0) },
      projectRoot: ROOT,
      runtimeRoot: RUNTIME_ROOT,
      io,
    },
    "stop",
    guardConfig({
      stopStep: async () => {
        stopSteps += 1;
        return true;
      },
    }),
  );

  assert.equal(exit, 1);
  assert.equal(stopSteps, 0, "jau užblokuotas guard'as lint žingsnio nebekviečia");
  const guardLog = world.store.get("vq/logs/frontend-guard.log") ?? "";
  assert.match(guardLog, /scan: apps\/web\/src\/App\.tsx/);
  assert.match(guardLog, /no-any:1/);
  assert.equal(err[0], "Frontend guard rado pažeidimų.");
});

test("runFileLineGuard: švarus skenas kviečia postScan ir stopStep tik stop režime", async () => {
  const world = fakeFs({ "apps/web/src/App.tsx": "const x = 1\n" });
  const ports = {
    fs: world.fs,
    collectChangedFiles: async (): Promise<string[]> => ["apps/web/src/App.tsx"],
    now: (): Date => new Date(0),
  };

  let postScans = 0;
  const { io } = captureIo();
  const postExit = await runFileLineGuard(
    { ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io },
    "post",
    guardConfig({
      postScan: async (_root, push) => {
        postScans += 1;
        push("post: ok");
      },
      stopStep: async () => true,
    }),
  );
  assert.equal(postExit, 0, "post režime stopStep nebėga");
  assert.equal(postScans, 1);
  assert.match(world.store.get("vq/logs/frontend-guard.log") ?? "", /post: ok/);
  assert.match(world.store.get("vq/logs/hooks.log") ?? "", /Frontend guard ✅/);

  const stopIo = captureIo();
  const stopExit = await runFileLineGuard(
    { ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: stopIo.io },
    "stop",
    guardConfig({ stopStep: async () => true }),
  );
  assert.equal(stopExit, 1, "stopStep blokavo — jis pats atsakingas už savo žurnalą");
});

test("runFileLineGuard: extraFile pažymi neklasifikuotą, bet reikšmingą failą", async () => {
  const world = fakeFs({ "apps/mobile/app.json": "{}" });
  const { io } = captureIo();
  const exit = await runFileLineGuard(
    {
      ports: { fs: world.fs, collectChangedFiles: async () => ["apps/mobile/app.json"], now: () => new Date(0) },
      projectRoot: ROOT,
      runtimeRoot: RUNTIME_ROOT,
      io,
    },
    "post",
    guardConfig({
      extraFile: async (file, _fullPath, push) => {
        push(`extra: ${file}`);
        return true;
      },
    }),
  );

  assert.equal(exit, 0);
  assert.match(world.store.get("vq/logs/frontend-guard.log") ?? "", /extra: apps\/mobile\/app\.json/);
});
