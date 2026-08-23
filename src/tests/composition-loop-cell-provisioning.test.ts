// `provisionLoopRuntime` — kur adapteris IMA loop'o veikimo aplinką.
//
// Šis failas atsirado dėl vienos eilutės. Aprūpinimo šaltinis buvo `process.cwd()`, o benchmark
// harness'as celę paleidžia SU cwd scenarijaus kopijoje — tad šaltinis rodė į taikinį, rasdavo
// tuščia, ir fail-closed vartas atmesdavo kiekvieną `ag-loop` celę. Rankinis paleidimas iš repo
// šaknies veikė, tad defektas buvo nematomas visur, išskyrus tikrą paleidimą.
//
// Tai ta pati taisyklė, kurią `runtime-context.ts` jau formuluoja `install` komandai: kopijuojant
// iš paketo į svetimą medį, šaltinio kelio negalima vesti iš taikinio.

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { benchmarkLoopCellPorts } from "../composition/runtime/integration-adapters.js";

let workdir = "";
let originalCwd = "";

before(async () => {
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(os.tmpdir(), "vq-cell-provision-"));
});

after(async () => {
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

test("aprūpinimas nepriklauso nuo cwd: šaltinis yra paketas, ne darbo katalogas", async () => {
  // Būtent taip celę paleidžia harness'as — cwd yra scenarijaus kopija.
  process.chdir(workdir);

  const result = await benchmarkLoopCellPorts.provisionLoopRuntime(workdir);

  assert.ok(result.agents > 0, "roster'is privalo ateiti iš paketo, o ne iš tuščio taikinio");
  const agents = await readdir(path.join(workdir, ".claude", "agents"));
  assert.ok(agents.includes("readme-guard.md"), "grandinės pirmas agentas privalo pasiekti kopiją");
  assert.ok(agents.includes("coder.md"));

  // Konfigų aibė, ne pavieniai failai: pilotas du kartus iš eilės sustojo ties kitu trūkstamu
  // failu (`agents.json`, paskui `tool-budget.json`), ir kiekvienas toks atradimas kainavo
  // mokamą paleidimą.
  const config = await readdir(path.join(workdir, "vq", "config"));
  assert.ok(config.includes("agents.json"), "be politikos roster'is lieka tuščias");
  assert.ok(config.includes("tool-budget.json"));
});
