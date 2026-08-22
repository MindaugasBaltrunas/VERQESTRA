// Paskutiniai trys E5 komandų įėjimai: `build-gate`, `milestone-check`, `release-check`.
//
// Testuojamos DVI atskiros savybės, nes jos gali lūžti nepriklausomai:
//  1. handler'io exit kontraktas ir ataskaitos forma (grynas kelias, be portų realizacijų);
//  2. ar komanda apskritai PASIEKIAMA per registrą — būtent to trūko iki šiol: logika gyveno
//     application sluoksnyje be kvietėjo, ir joks testas to nematė.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  DIST_REBUILD_COMMAND,
  renderBuildGateReport,
  type BuildGateStaleFile,
} from "../application/release-readiness/build-gate.js";
import { buildGateCommand } from "../interfaces/cli/audit/build-gate.js";
import { milestoneCheckCommand } from "../interfaces/cli/audit/milestone-check.js";
import { releaseCheckCommand } from "../interfaces/cli/audit/release-check.js";
import { buildCliCommands } from "../composition/cli-registry.js";
import type { MilestoneCheckPorts, MilestoneCheckRunners } from "../application/release-readiness/milestone-check.js";
import type { ReleaseCheckPorts, ReleaseCheckRunners } from "../application/release-readiness/release-check.js";
import type { SecurityVerifyResult } from "../application/quality-gates/security-verify.js";
import type { QualityGatesStatus } from "../application/quality-gates/quality-gates-status.js";
import type { CliIo } from "../interfaces/cli/registry.js";

const ROOT = path.resolve("/tmp/vq-release-gates");
const stale = (name: string): BuildGateStaleFile => ({
  sourcePath: path.join(ROOT, "src", `${name}.ts`),
  distPath: path.join(ROOT, "dist", `${name}.js`),
  reason: "stale",
});

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

test("build-gate: ataskaita — vienas OK sakinys, o stale atveju rebuild komanda ir iki 10 pavyzdžių", () => {
  assert.match(renderBuildGateReport(ROOT, []), /^build-gate: ok/);

  const many = Array.from({ length: 12 }, (_, index) => stale(`m${index}`));
  const report = renderBuildGateReport(ROOT, many);
  assert.match(report, /^build-gate: stale — 12 generated file\(s\) behind src\./);
  assert.ok(report.includes(`Fix: ${DIST_REBUILD_COMMAND}`), "rebuild komanda yra ataskaitoje");
  const listed = report.split("\n").filter((line) => line.startsWith("  - "));
  assert.equal(listed.length, 10, "rodomi tik pirmi dešimt — pilnas sąrašas paskandintų komandą");
  // Keliai santykiniai paketo šaknies atžvilgiu: absoliutus kelias ataskaitą paverstų
  // nepalyginama tarp mašinų.
  assert.ok(listed[0]?.includes("src") && !listed[0]?.includes(ROOT), "keliai santykiniai");
});

test("build-gate: exit kontraktas — fresh 0, stale 1 per stderr, portų klaida 2", async () => {
  const fresh = captureIo();
  assert.equal(
    await buildGateCommand({ ports: { findStaleDistFiles: async () => [] }, packageRoot: ROOT, io: fresh.io }, []),
    0,
  );
  assert.equal(fresh.err.length, 0, "švarus verdiktas neina į stderr");

  const dirty = captureIo();
  assert.equal(
    await buildGateCommand(
      { ports: { findStaleDistFiles: async () => [stale("a")] }, packageRoot: ROOT, io: dirty.io },
      [],
    ),
    1,
  );
  assert.equal(dirty.out.length, 0, "gedimo ataskaita NEINA į stdout — CI jį skaito kaip duomenis");
  assert.match(dirty.err.join("\n"), /build-gate: stale/);

  const broken = captureIo();
  assert.equal(
    await buildGateCommand(
      {
        ports: {
          findStaleDistFiles: () => Promise.reject(new Error("fs down")),
        },
        packageRoot: ROOT,
        io: broken.io,
      },
      [],
    ),
    2,
  );
  assert.deepEqual(broken.err, ["fs down"]);
});

const GREEN_QUALITY: QualityGatesStatus = {
  passed: true,
  exit_code: 0,
  has_commands: true,
  scope: "milestone",
  commands: ["pnpm test"],
  skipped: [],
  failed_gates: [],
  results: [],
  updated_at: "2026-08-22T09:00:00Z",
};

const EMPTY_SECURITY: SecurityVerifyResult = {
  status: "blocked",
  files: [],
  blocked_paths: [],
  text_findings: [],
  warnings: [],
  result_path: "vq/state/security-verify-result.json",
};

function milestoneDeps(quality: QualityGatesStatus): {
  ports: MilestoneCheckPorts;
  runners: MilestoneCheckRunners;
  written: unknown[];
} {
  const written: unknown[] = [];
  return {
    ports: { activeChangeId: async () => undefined, writeResult: async (result) => void written.push(result) },
    runners: {
      quality: async () => quality,
      specAlignment: async () => {
        throw new Error("spec-drift neturi būti kviečiamas be aktyvaus change");
      },
      localPolicy: async () => EMPTY_SECURITY,
    },
    written,
  };
}

test("milestone-check: exit kontraktas ir santrauka", async () => {
  const green = captureIo();
  const okDeps = milestoneDeps(GREEN_QUALITY);
  assert.equal(await milestoneCheckCommand({ ...okDeps, io: green.io }, []), 0);
  assert.deepEqual(green.out, ["milestone-check: ok", "failed_parts: none"]);
  assert.equal(okDeps.written.length, 1, "verdiktas įrašomas per portą");

  const red = captureIo();
  const failedDeps = milestoneDeps({ ...GREEN_QUALITY, passed: false, exit_code: 1 });
  assert.equal(await milestoneCheckCommand({ ...failedDeps, io: red.io }, []), 1);
  assert.deepEqual(red.out, ["milestone-check: failed", "failed_parts: quality"]);
});

test("release-check: exit kontraktas, verdikto kelias ir source-state įėjimai", async () => {
  const written: unknown[] = [];
  const readFiles: string[] = [];
  const ports: ReleaseCheckPorts = {
    fs: {
      listFilesRecursive: async (absoluteDir) =>
        absoluteDir.endsWith("src") ? [path.join(absoluteDir, "cli.ts")] : [],
      exists: async (absolutePath) => absolutePath.endsWith("package.json"),
      readTextFile: async (absolutePath) => {
        readFiles.push(path.relative(ROOT, absolutePath).split(path.sep).join("/"));
        return "x";
      },
      readTextFileIfExists: async () => undefined,
    },
    writeResult: async (result) => void written.push(result),
  };
  const runners: ReleaseCheckRunners = {
    build: async () => ({ command: "pnpm build", exitCode: 0 }),
    tests: async () => ({ command: "pnpm test:only", exitCode: 0 }),
    milestone: async (quality) => ({
      status: "ok",
      quality: { status: "ok", result: quality },
      spec_alignment: { status: "skipped" },
      local_policy: { status: "skipped", result: EMPTY_SECURITY },
      failed_parts: [],
      result_path: "vq/state/milestone-check-result.json",
      updated_at: "2026-08-22T09:00:00Z",
    }),
    docs: async () => ({ status: "ok", issues: [] }),
    packageLayout: async () => ({ status: "ok", issues: [] }),
  };

  const green = captureIo();
  assert.equal(
    await releaseCheckCommand(
      {
        ports,
        runners,
        projectRoot: ROOT,
        sourceStateInputs: { dirs: ["src"], files: ["package.json", "nera.json"] },
        io: green.io,
      },
      [],
    ),
    0,
  );
  assert.deepEqual(green.out, [
    "release-check: ok",
    "failed_parts: none",
    "result: vq/state/release-check-result.json",
  ]);
  // Įėjimų sąrašas nueina iki hash'o: nesantis failas praleidžiamas, katalogas išskleidžiamas.
  assert.deepEqual(readFiles, ["package.json", "src/cli.ts"]);
  assert.equal(written.length, 1);

  const red = captureIo();
  assert.equal(
    await releaseCheckCommand(
      {
        ports,
        runners: { ...runners, docs: async () => ({ status: "failed", issues: ["README link is broken: docs/x.md"] }) },
        projectRoot: ROOT,
        io: red.io,
      },
      [],
    ),
    1,
  );
  assert.equal(red.out[0], "release-check: failed");
  assert.equal(red.out[1], "failed_parts: docs");
});

test("registras: trys komandos PASIEKIAMOS, o ne tik parašytos", () => {
  const roots = {
    projectRoot: ROOT,
    runtimeRoot: path.join(ROOT, "vq"),
    agRoot: path.join(ROOT, "AG"),
  };
  const names = new Set(buildCliCommands({ roots }).map((command) => command.name));
  for (const name of ["build-gate", "milestone-check", "release-check"]) {
    assert.ok(names.has(name), `komanda "${name}" neįrašyta į registrą — CLI jos neturi`);
  }
});
