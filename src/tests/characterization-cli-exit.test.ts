// VQ-50A auditas — CLI exit kontraktai.
//
// Etalonas yra DUOMENYS (`fixtures/characterization/cli-exit-contracts.json`), o ne šio failo
// tekstas: taip kontraktas lieka palyginamas su AG_loop atitikmeniu, o testas tik jį vykdo.
//
// Kiekvienas atvejis paleidžiamas per TIKRĄ registrą (`buildCliCommands`) švariame laikiname
// workspace — ne per handler'io importą. Tai svarbu: registras yra vieta, kur komanda gali būti
// neprijungta arba prijungta su kitais portais, ir būtent tą riziką auditas turi matyti.
//
// NUKRYPIMAS nuo etalono (griežtinantis): tikrinama GRĄŽINTA reikšmė, o ne `process.exitCode` —
// VERQESTRA handler'iai kodą grąžina, tad jokia globali proceso būsena čia nedalyvauja.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../composition/cli-main.js";
import { buildCliCommands } from "../composition/cli-registry.js";
import type { CliIo } from "../interfaces/cli/registry.js";

type ExitContractCase = {
  id: string;
  command: string;
  argv: string[];
  expect: { exitCode: number; stderrIncludes: string[] };
};

type ExitContractFixture = {
  schema_version: number;
  workspace_dirs: string[];
  cases: ExitContractCase[];
};

const FIXTURE = path.join(process.cwd(), "src", "tests", "fixtures", "characterization", "cli-exit-contracts.json");

async function loadFixture(): Promise<ExitContractFixture> {
  return JSON.parse(await readFile(FIXTURE, "utf8")) as ExitContractFixture;
}

test("CLI exit kontraktai: kiekvienas atvejis per TIKRĄ registrą", async () => {
  const fixture = await loadFixture();
  assert.equal(fixture.schema_version, 1);
  assert.ok(fixture.cases.length > 0);

  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "vq-50a-exit-"));
  try {
    for (const dir of fixture.workspace_dirs) await mkdir(path.join(projectRoot, dir), { recursive: true });

    const roots = {
      projectRoot,
      runtimeRoot: path.join(projectRoot, "vq"),
      agRoot: path.join(projectRoot, "AG"),
    };

    for (const testCase of fixture.cases) {
      const err: string[] = [];
      const io: CliIo = { out: () => {}, error: (line) => err.push(line) };
      const commands = buildCliCommands({ roots, io });

      const code = await runCli({ commands, io }, [testCase.command, ...testCase.argv]);
      const stderr = err.join("\n");

      assert.equal(code, testCase.expect.exitCode, `${testCase.id}: exit kodas`);
      for (const fragment of testCase.expect.stderrIncludes) {
        assert.ok(stderr.includes(fragment), `${testCase.id}: stderr be „${fragment}" (buvo: ${stderr})`);
      }
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("registras: kiekviena komanda turi vardą, aprašą ir surištą vykdytoją", () => {
  const io: CliIo = { out: () => {}, error: () => {} };
  const commands = buildCliCommands({
    roots: { projectRoot: process.cwd(), runtimeRoot: path.join(process.cwd(), "vq"), agRoot: path.join(process.cwd(), "AG") },
    io,
  });

  assert.ok(commands.length >= 50, `laukta bent 50 komandų, rasta ${commands.length}`);
  const names = new Set<string>();
  for (const command of commands) {
    assert.ok(command.name.trim().length > 0, "komanda be vardo");
    assert.ok(command.description.trim().length > 0, `${command.name}: be aprašo`);
    assert.equal(typeof command.run, "function", `${command.name}: be vykdytojo`);
    // Dublikatas registre reikštų, kad viena iš dviejų komandų niekada nebus pasiekta.
    assert.equal(names.has(command.name), false, `${command.name}: dublikatas registre`);
    names.add(command.name);
  }
});
