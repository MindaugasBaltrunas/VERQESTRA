// VQ-502 (4/6-a) testai — produkto formos guard'ai ir PostToolUse fan-out. Svarbiausia, ką
// jie pin'ina: BLOCK/WARN skirtis kiekvienam taisyklių rinkiniui, lint/typecheck bėga TIK
// stop režime ir tik praėjus aplinkos vartus, o post-write fan-out niekada neblokuoja ir
// nepaleidžia guard'o, kurio produkto šaknies nėra.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  backendLineRules,
  frontendLineRules,
  isUnauthenticatedMutatingRoute,
  mobileLineRules,
  scanLineRules,
} from "../domain/policies/index.js";
import type { GuardRootKey } from "../domain/project/index.js";
import type { HookFsPort, HookIo } from "../interfaces/hooks/protocol.js";
import {
  hookBackendGuard,
  hookFrontendGuard,
  hookMobileGuard,
  type ScopeGuardPorts,
  type ShellCommandResult,
} from "../interfaces/hooks/scope-guards.js";
import {
  POST_WRITE_GUARDS,
  applicableGuards,
  runPostWriteGuards,
  type PostWriteGuardPorts,
} from "../interfaces/hooks/post-write-guards.js";

const ROOT = path.resolve("/repo");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const norm = (value: string): string => value.replace(/\\/g, "/");
const rel = (absolute: string): string => norm(path.relative(ROOT, absolute));
const GUARD_ROOTS: Record<GuardRootKey, string> = { frontend: "apps/web", backend: "apps/api", mobile: "apps/mobile" };

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
// domain: taisyklių rinkiniai
// ---------------------------------------------------------------------------

test("backendLineRules: eval ir exec su kintamuoju blokuoja, stilius — tik įspėja", () => {
  const blocking = scanLineRules("apps/api/src/routes/x.ts", "const r = eval(input)\n", [...backendLineRules]);
  assert.equal(blocking.blocked, true);
  assert.ok(blocking.findings.some((line) => line.includes("BLOCK") && line.includes("eval()")));

  const injected = scanLineRules("apps/api/src/routes/x.ts", "exec(`ls ${req.body.dir}`)\n", [...backendLineRules]);
  assert.equal(injected.blocked, true);

  const warnOnly = scanLineRules("apps/api/src/routes/x.ts", "console.log('hi')\nrouter.post('/x', handler)\n", [
    ...backendLineRules,
  ]);
  assert.equal(warnOnly.blocked, false);
  assert.ok(warnOnly.findings.some((line) => line.includes("console.log")));
  assert.ok(warnOnly.findings.some((line) => line.includes("may lack request validation")));
});

test("isUnauthenticatedMutatingRoute: mutuojantis maršrutas be auth signalo, bet auth failai praleidžiami", () => {
  const content = "router.post('/users', createUser)\n";
  assert.equal(isUnauthenticatedMutatingRoute("apps/api/src/routes/users.routes.ts", content), true);
  assert.equal(isUnauthenticatedMutatingRoute("apps/api/src/routes/auth.routes.ts", content), false);
  assert.equal(
    isUnauthenticatedMutatingRoute("apps/api/src/routes/users.routes.ts", `router.use(auth)\n${content}`),
    false,
  );
  assert.equal(isUnauthenticatedMutatingRoute("apps/api/src/services/users.ts", content), false);
});

test("frontendLineRules: hooks išjungimas be priežasties blokuoja, su priežastimi — praeina", () => {
  const withoutReason = scanLineRules(
    "apps/web/src/App.tsx",
    "// eslint-disable-next-line react-hooks/rules-of-hooks\n",
    [...frontendLineRules],
  );
  assert.equal(withoutReason.blocked, true);

  const withReason = scanLineRules(
    "apps/web/src/App.tsx",
    "// eslint-disable-next-line react-hooks/rules-of-hooks -- reikia del legacy wrapper\n",
    [...frontendLineRules],
  );
  assert.equal(withReason.blocked, false);

  const unsafeHtml = scanLineRules("apps/web/src/App.tsx", "<div dangerouslySetInnerHTML={x} />\n", [
    ...frontendLineRules,
  ]);
  assert.equal(unsafeHtml.blocked, true);
});

test("mobileLineRules: slaptukai AsyncStorage ir localhost blokuoja, console.log klaidoje — ne", () => {
  const secrets = scanLineRules("apps/mobile/a.ts", "AsyncStorage.setItem('refresh_token', t)\n", [...mobileLineRules]);
  assert.equal(secrets.blocked, true);

  const local = scanLineRules("apps/mobile/a.ts", "fetch('http://localhost:3000/x')\n", [...mobileLineRules]);
  assert.equal(local.blocked, true);

  // `console.log` su error/catch kontekste NĖRA įspėjimas — tai teisėtas klaidų kelias.
  const errorLog = scanLineRules("apps/mobile/a.ts", "catch (e) { console.log(e) }\n", [...mobileLineRules]);
  assert.equal(errorLog.blocked, false);
  assert.deepEqual(errorLog.findings, []);
});

// ---------------------------------------------------------------------------
// hooks: scope guard wiring
// ---------------------------------------------------------------------------

function scopePorts(
  fs: HookFsPort,
  input: { changed?: string[]; commandExists?: boolean; shell?: ShellCommandResult } = {},
): { ports: ScopeGuardPorts; shellCalls: string[] } {
  const shellCalls: string[] = [];
  return {
    shellCalls,
    ports: {
      fs,
      collectChangedFiles: async () => input.changed ?? [],
      now: () => new Date("2026-08-21T00:00:00.000Z"),
      guardRoots: async () => GUARD_ROOTS,
      commandExists: async () => input.commandExists ?? true,
      runShell: async (command) => {
        shellCalls.push(command);
        return input.shell ?? { code: 0, stdout: "", stderr: "" };
      },
    },
  };
}

test("hookBackendGuard: blokuojanti taisyklė duoda 1 ir NIEKADA nepaleidžia shell komandos", async () => {
  const world = fakeFs({ "apps/api/src/routes/x.ts": "const r = eval(input)\n" });
  const ports = scopePorts(world.fs, { changed: ["apps/api/src/routes/x.ts"] });
  const { io, err } = captureIo();

  const exit = await hookBackendGuard({ ports: ports.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io });
  assert.equal(exit, 1);
  assert.deepEqual(ports.shellCalls, [], "backend guard'as neturi stop tęsinio");
  assert.match(world.store.get("vq/logs/backend-guard.log") ?? "", /BLOCK: .*eval\(\)/);
  assert.equal(err[0], "Backend guard rado blokuojanciu Express saugumo problemu.");
});

test("hookFrontendGuard: lint bėga TIK stop režime ir tik praėjus aplinkos vartus", async () => {
  const files = {
    "apps/web/src/App.tsx": "export const A = () => null\n",
    "apps/web/package.json": '{ "scripts": { "lint": "eslint ." } }',
  };

  const post = scopePorts(fakeFs(files).fs, { changed: ["apps/web/src/App.tsx"] });
  assert.equal(
    await hookFrontendGuard({ ports: post.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: captureIo().io }, [
      "post",
    ]),
    0,
  );
  assert.deepEqual(post.shellCalls, [], "post režime lint nepaleidžiamas");

  const stop = scopePorts(fakeFs(files).fs, { changed: ["apps/web/src/App.tsx"] });
  assert.equal(
    await hookFrontendGuard({ ports: stop.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: captureIo().io }, [
      "stop",
    ]),
    0,
  );
  assert.deepEqual(stop.shellCalls, ["pnpm --dir apps/web lint"]);

  // Be `lint` script'o arba be pnpm komanda nepaleidžiama — kitaip blokas kiltų dėl aplinkos.
  const noScript = scopePorts(fakeFs({ "apps/web/src/App.tsx": "x\n", "apps/web/package.json": "{}" }).fs, {
    changed: ["apps/web/src/App.tsx"],
  });
  assert.equal(
    await hookFrontendGuard({ ports: noScript.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: captureIo().io }, [
      "stop",
    ]),
    0,
  );
  assert.deepEqual(noScript.shellCalls, []);

  const noPnpm = scopePorts(fakeFs(files).fs, { changed: ["apps/web/src/App.tsx"], commandExists: false });
  assert.equal(
    await hookFrontendGuard({ ports: noPnpm.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: captureIo().io }, [
      "stop",
    ]),
    0,
  );
  assert.deepEqual(noPnpm.shellCalls, []);
});

test("hookFrontendGuard: nepavykęs lint blokuoja ir įrašo savo žurnalą", async () => {
  const world = fakeFs({
    "apps/web/src/App.tsx": "export const A = () => null\n",
    "apps/web/package.json": '{ "scripts": { "lint": "eslint ." } }',
  });
  const ports = scopePorts(world.fs, {
    changed: ["apps/web/src/App.tsx"],
    shell: { code: 1, stdout: "err", stderr: "" },
  });
  const { io, err } = captureIo();

  const exit = await hookFrontendGuard({ ports: ports.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io }, ["stop"]);
  assert.equal(exit, 1);
  assert.equal(world.store.get("vq/logs/frontend-lint.log"), "err");
  assert.match(err[0] ?? "", /Frontend lint nepraejo/);
});

test("hookMobileGuard: app.json su debug:true pažymimas net be .ts pakeitimų", async () => {
  const world = fakeFs({ "apps/mobile/app.json": '{ "debug": true }' });
  const ports = scopePorts(world.fs, { changed: ["apps/mobile/app.json"] });

  const exit = await hookMobileGuard({ ports: ports.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: captureIo().io }, [
    "post",
  ]);
  assert.equal(exit, 0);
  const guardLog = world.store.get("vq/logs/mobile-guard.log") ?? "";
  assert.match(guardLog, /debug:true detected/);
  assert.ok(!guardLog.startsWith("skipped:"), "app.json laikomas reikšmingu pakeitimu");
});

test("hookMobileGuard: typecheck klaidos suskaičiuojamos iš išvesties", async () => {
  const world = fakeFs({
    "apps/mobile/a.ts": "export const a = 1\n",
    "apps/mobile/tsconfig.json": "{}",
  });
  const ports = scopePorts(world.fs, {
    changed: ["apps/mobile/a.ts"],
    shell: { code: 2, stdout: "a.ts(1,1): error TS1005: x\nb.ts(2,2): error TS1109: y\n", stderr: "" },
  });
  const { io, err } = captureIo();

  const exit = await hookMobileGuard({ ports: ports.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io }, ["stop"]);
  assert.equal(exit, 1);
  assert.deepEqual(ports.shellCalls, ["npm run typecheck --prefix apps/mobile"]);
  assert.match(err[0] ?? "", /Mobile TypeScript nepraejo \(2 klaidu\)/);
});

// ---------------------------------------------------------------------------
// hooks: post-write fan-out
// ---------------------------------------------------------------------------

test("applicableGuards: šaknies neturintys guard'ai visada taikomi, produkto — tik esant šakniai", () => {
  const none = applicableGuards(POST_WRITE_GUARDS, { frontend: false, backend: false, mobile: false });
  assert.deepEqual(
    none.map((guard) => guard.command),
    ["hook-secret-scan", "hook-package-guard", "hook-migration-guard"],
  );

  const withFrontend = applicableGuards(POST_WRITE_GUARDS, { frontend: true, backend: false, mobile: false });
  assert.ok(withFrontend.some((guard) => guard.command === "hook-frontend-guard"));
  // frontend/mobile gauna eksplicitinį `post`, kad stop tęsiniai nebūtų paleisti po kiekvieno rašymo.
  assert.deepEqual(withFrontend.find((guard) => guard.command === "hook-frontend-guard")?.args, ["post"]);
  assert.deepEqual(POST_WRITE_GUARDS.find((guard) => guard.command === "hook-backend-guard")?.args, []);
});

function postWritePorts(
  fs: HookFsPort,
  input: { existingRoots?: string[]; exitCodes?: Record<string, number> } = {},
): { ports: PostWriteGuardPorts; ran: string[] } {
  const existing = new Set(input.existingRoots ?? []);
  const ran: string[] = [];
  return {
    ran,
    ports: {
      fs: { ...fs, exists: async (p) => existing.has(norm(p).replace(`${norm(ROOT)}/`, "")) },
      guardRoots: async () => GUARD_ROOTS,
      runGuard: async (command) => {
        ran.push(command);
        return input.exitCodes?.[command] ?? 0;
      },
      now: () => new Date("2026-08-21T00:00:00.000Z"),
    },
  };
}

test("runPostWriteGuards: paleidžia tik taikomus guard'us ir NIEKADA neblokuoja", async () => {
  const world = fakeFs();
  const ports = postWritePorts(world.fs, {
    existingRoots: ["apps/web"],
    exitCodes: { "hook-secret-scan": 1 },
  });

  const exit = await runPostWriteGuards({ ports: ports.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT });

  assert.equal(exit, 0, "PostToolUse niekada neblokuoja rašymo");
  assert.deepEqual(ports.ran.sort(), [
    "hook-frontend-guard",
    "hook-migration-guard",
    "hook-package-guard",
    "hook-secret-scan",
  ]);
  // Nepavykęs guard'as lieka žurnale — signalas Stop hook'ui, ne blokada čia.
  assert.match(world.store.get("vq/logs/hooks.log") ?? "", /hook-secret-scan exit=1/);
});
