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
import { benchmarkLoopCellCommand } from "../interfaces/cli/benchmark/benchmark-loop-cell.js";
import type { LoopCellPorts } from "../interfaces/cli/benchmark/benchmark-loop-cell.js";
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
