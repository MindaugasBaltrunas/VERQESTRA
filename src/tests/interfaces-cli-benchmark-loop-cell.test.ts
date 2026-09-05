// `benchmark-loop-cell` komanda su suklastotais portais.
//
// Kodėl šis failas atsirado tik po piloto: gryna celės dalis buvo padengta
// (`interfaces-cli-benchmark-cell.test.ts`), o PATI komanda — ne. 2026-08-22 pilotas parodė, ko
// tai kainuoja: kopijoje nebuvo `.claude/agents/`, preflight promptas modeliui pateikė tuščią
// leistinų agentų sąrašą ir čia pat pareikalavo netuščios grandinės, tad kiekviena `ag-loop` celė
// deterministiškai baigdavosi human-review po vieno kvietimo. Nė vienas testas to nematė, nes nė
// vienas nepaleido komandos.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  benchmarkLoopCellCommand,
  parseLoopCellArgs,
} from "../interfaces/cli/benchmark/benchmark-loop-cell.js";
import type { LoopCellPorts, ParsedLoopCellArgs } from "../interfaces/cli/benchmark/benchmark-loop-cell.js";
import { USAGE_ERROR_EXIT_CODE } from "../shared/exit-codes.js";

const ARGS = [
  "--workdir",
  path.join(path.sep === "/" ? "/tmp" : "C:\tmp", "cell"),
  "--model",
  "claude-sonnet-5",
  "--step-limit",
  "12",
  "--timeout-ms",
  "600000",
  "--task-id",
  "bugfix-i18n",
  "--allowed-paths",
  "src/i18n.mjs",
  "--checks",
  "node --test test/i18n.test.mjs",
];

type Recorded = {
  written: string[];
  cycles: number;
  errors: string[];
};

function ports(agents: number, recorded: Recorded): LoopCellPorts {
  return {
    isDirectory: () => Promise.resolve(true),
    readStdin: () => Promise.resolve("Fix the missing key fallback."),
    writeTextFile: (absolutePath) => {
      recorded.written.push(absolutePath);
      return Promise.resolve();
    },
    provisionLoopRuntime: () => Promise.resolve({ agents }),
    runCycle: () => {
      recorded.cycles += 1;
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    readUsageRecords: () =>
      Promise.resolve([
        {
          task_id: "bugfix-i18n",
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 300,
          num_turns: 2,
          attempt: 1,
          usage_captured: true,
        },
      ]),
    humanReviewCount: () => Promise.resolve(0),
    isUsageLimitOutput: () => false,
  };
}

function run(agents: number): Promise<{ code: number; recorded: Recorded; out: string[] }> {
  const recorded: Recorded = { written: [], cycles: 0, errors: [] };
  const out: string[] = [];
  return benchmarkLoopCellCommand(
    {
      ports: ports(agents, recorded),
      io: {
        out: (line) => out.push(line),
        error: (line) => recorded.errors.push(line),
      },
    },
    ARGS,
  ).then((code) => ({ code, recorded, out }));
}

test("be agentų roster'io celė ATSISAKO, o ne matuoja mūsų aprūpinimą", async () => {
  const { code, recorded } = await run(0);
  assert.equal(code, USAGE_ERROR_EXIT_CODE);
  assert.equal(recorded.cycles, 0, "ciklas neturi būti paleistas: jis kainuotų ir nieko neišmatuotų");
  assert.match(recorded.errors.join("\n"), /no agent definition reached the checkout/);
});

test("su roster'iu ciklas paleidžiamas ir vokas išspausdinamas", async () => {
  const { code, recorded, out } = await run(16);
  assert.equal(code, 0);
  assert.equal(recorded.cycles, 1);
  const envelope = JSON.parse(out.join("")) as {
    inputTokens: number;
    usage: { cacheCreationInputTokens: number };
  };
  assert.equal(envelope.inputTokens, 10);
  // Cache creation privalo pasiekti voką: be jo režimų kaštų metrika matuotų dalį sąskaitos.
  assert.equal(envelope.usage.cacheCreationInputTokens, 300);
});

test("aprūpinimas įvyksta PRIEŠ ciklą, ne po jo", async () => {
  // Užduotis, spec change'as ir kokybės politika parašomi anksčiau; roster'is yra paskutinė
  // sąlyga, be kurios ciklas neturi prasmės, tad jo tikrinimas privalo blokuoti paleidimą.
  const { recorded } = await run(0);
  assert.ok(
    recorded.written.some((written) => written.includes(path.join("AG", "tasks", "queue"))),
    "užduotis parašoma prieš atsisakymą — atsisakymas yra dėl roster'io, ne dėl argumentų",
  );
  assert.equal(recorded.cycles, 0);
});

// --- parseLoopCellArgs: vienaskaitos aliasai (full-audit-2026-09-05, P1-C6) -------------------
//
// README:219 ir registro usage skelbė `--allowed-path <p> [--check <cmd>]`, o parseris priėmė
// tik daugiskaitą. Benchmark paketas veikė (jo šablonas rašo daugiskaitą), tad spragą matė tik
// rankinis operatorius — ir tiksliai tai čia ir tikrinama.

const BASE = ["--workdir", "/tmp/cell", "--model", "claude-sonnet-5", "--step-limit", "12", "--timeout-ms", "600000"];

function parsed(...tail: readonly string[]): ParsedLoopCellArgs {
  const result = parseLoopCellArgs([...BASE, ...tail]);
  assert.equal(result.kind, "ok", result.kind === "error" ? result.message : "");
  if (result.kind !== "ok") throw new Error("unreachable");
  return result.args;
}

function rejected(...tail: readonly string[]): string {
  const result = parseLoopCellArgs([...BASE, ...tail]);
  assert.equal(result.kind, "error");
  return result.kind === "error" ? result.message : "";
}

test("parseLoopCellArgs: kartojama vienaskaita ≡ daugiskaitos | sąrašas", () => {
  const singular = parsed("--allowed-path", "src/a.js", "--allowed-path", "src/b.js");
  const plural = parsed("--allowed-paths", "src/a.js|src/b.js");
  assert.deepEqual(singular.allowedPaths, ["src/a.js", "src/b.js"]);
  assert.deepEqual(singular.allowedPaths, plural.allowedPaths);
});

test("parseLoopCellArgs: mišri forma sudedama argumentų tvarka, be dedup", () => {
  const args = parsed(
    "--allowed-paths",
    "src/a.js|src/b.js",
    "--allowed-path",
    "src/c.js",
    "--allowed-path",
    "src/a.js",
  );
  assert.deepEqual(args.allowedPaths, ["src/a.js", "src/b.js", "src/c.js", "src/a.js"]);
});

test("parseLoopCellArgs: --check veikia be --checks ir kartojasi", () => {
  const args = parsed(
    "--allowed-path",
    "src/a.js",
    "--check",
    "node --test test/a.test.mjs",
    "--check",
    "node --test test/b.test.mjs",
  );
  assert.deepEqual(args.checks, ["node --test test/a.test.mjs", "node --test test/b.test.mjs"]);
});

test("parseLoopCellArgs: kiti raktai lieka „paskutinis laimi\"", () => {
  // Kaupimas įjungtas TIK dviem sąrašo vėliavoms — `--model` semantika nepakitusi.
  const args = parsed("--allowed-path", "src/a.js", "--model", "claude-opus-5");
  assert.equal(args.model, "claude-opus-5");
});

test("parseLoopCellArgs: esami klaidų atvejai nepakitę", () => {
  assert.match(rejected("--checks", "node --test"), /must name at least one path/);
  // Tuščias alias'as po trim'o lieka tuščiu sąrašu, o ne „viskas leidžiama".
  assert.match(rejected("--allowed-path", "  "), /must name at least one path/);
  const negativeStep = parseLoopCellArgs([
    "--workdir",
    "/tmp/cell",
    "--model",
    "claude-sonnet-5",
    "--step-limit",
    "-3",
    "--timeout-ms",
    "600000",
    "--allowed-path",
    "src/a.js",
  ]);
  assert.equal(negativeStep.kind, "error");
  assert.match(
    negativeStep.kind === "error" ? negativeStep.message : "",
    /--step-limit must be a positive integer/,
  );
});
