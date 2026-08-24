import assert from "node:assert/strict";
import test from "node:test";
import { LocalControlError } from "../application/local-control-errors.js";
import type { GateCommandOutcome } from "../application/ports/gate-command-runner-port.js";
import {
  assertGateCommandCatalogue,
  gateStatusOf,
  orderedGateCommands,
  REQUIRED_GATE_NAMES,
  type GateCommand,
  type GateCommandCatalogue,
} from "../application/session-gate-policy.js";
import {
  catalogueWith,
  gateCommand,
  NUL,
  shuffledCatalogue,
} from "./session-gate-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `session-gates.test.ts` buvo 984 eilutės).
 *
 * `session-gate-policy` yra GRYNA: ji sprendžia, kas apskritai gali būti vartas ir ką reiškia
 * proceso baigtis. Jai nereikia nei katalogų, nei registro, nei Git — todėl ji ir atskirai.
 */

function refusesCatalogue(catalogue: GateCommandCatalogue, label: string): void {
  assert.throws(
    () => assertGateCommandCatalogue(catalogue),
    (error: unknown) => {
      // A plain `Error`: this is host configuration, not a request a caller
      // made, so it must never be shaped like a protocol answer.
      assert.ok(error instanceof Error, label);
      assert.ok(!(error instanceof LocalControlError), label);
      assert.match(error.message, /Quality gate command is invalid/, label);
      return true;
    },
    label,
  );
}

test("a catalogue that does not describe every required gate exactly once is refused", () => {
  refusesCatalogue([], "an empty catalogue");
  refusesCatalogue(
    shuffledCatalogue().filter((command) => command.name !== "secret"),
    "a missing gate",
  );
  refusesCatalogue(
    [...shuffledCatalogue().filter((command) => command.name !== "secret"), gateCommand("readme")],
    "a duplicated gate",
  );
  refusesCatalogue(
    [...shuffledCatalogue(), { ...gateCommand("test"), name: "deploy" }],
    "a sixth, unknown gate",
  );
  refusesCatalogue(
    shuffledCatalogue().map((command) => (
      command.name === "test" ? { ...command, name: "deploy" } : command
    )),
    "an unknown gate name in place of a required one",
  );
  assert.doesNotThrow(() => assertGateCommandCatalogue(shuffledCatalogue()));
});

test("a gate command the host cannot vouch for is refused before a process exists", () => {
  const cases: ReadonlyArray<readonly [string, Partial<GateCommand>]> = [
    // A bare name is resolved by the operating system, and on Windows that may
    // mean the worktree the agent just wrote to.
    ["a relative executable", { executable: "node" }],
    ["an executable with a traversal segment", { executable: "/opt/tools/../node" }],
    // A batch file needs a command interpreter, and this package never opens one.
    ["a Windows batch file", { executable: "/opt/tools/gate.bat" }],
    ["a Windows command script", { executable: "/opt/tools/gate.cmd" }],
    ["an executable carrying a newline", { executable: "/opt/tools/no\nde" }],
    ["an argument carrying a NUL", { args: ["-e", `gate:test${NUL}rm -rf`] }],
    ["an argument carrying a newline", { args: ["-e", "gate:test\nrm"] }],
    ["an argument carrying a carriage return", { args: ["-e", "gate:test\rrm"] }],
    ["too many arguments", { args: Array.from({ length: 65 }, (_value, index) => `-${index}`) }],
    ["a time budget below the floor", { timeoutMs: 999 }],
    ["a time budget above the ceiling", { timeoutMs: 3_600_001 }],
    ["a fractional time budget", { timeoutMs: 1_500.5 }],
  ];
  for (const [label, overrides] of cases) {
    refusesCatalogue(catalogueWith("test", overrides), label);
  }
});

test("only a process that started, finished and exited zero passed", () => {
  const cases: ReadonlyArray<readonly [string, GateCommandOutcome, string]> = [
    ["a clean exit", { exitCode: 0, timedOut: false, startFailed: false, durationMs: 1 }, "passed"],
    ["a non-zero exit", { exitCode: 1, timedOut: false, startFailed: false, durationMs: 1 }, "failed"],
    ["a timeout", { timedOut: true, startFailed: false, durationMs: 1 }, "timed_out"],
    // A terminated process may still report a code; what it exhausted is the
    // fact that explains the result, so it outranks the code.
    ["a timeout that also reported a code", {
      exitCode: 0,
      timedOut: true,
      startFailed: false,
      durationMs: 1,
    }, "timed_out"],
    ["a start failure", { timedOut: false, startFailed: true, durationMs: 1 }, "errored"],
    ["a start failure that also reported a code", {
      exitCode: 0,
      timedOut: false,
      startFailed: true,
      durationMs: 1,
    }, "errored"],
    ["a start failure that also timed out", {
      timedOut: true,
      startFailed: true,
      durationMs: 1,
    }, "errored"],
    ["no exit code and no timeout", { timedOut: false, startFailed: false, durationMs: 1 }, "errored"],
  ];
  for (const [label, outcome, expected] of cases) {
    assert.equal(gateStatusOf(outcome), expected, label);
  }
});

test("the catalogue is ordered by the required list, whatever order the host wrote it in", () => {
  assert.deepEqual(
    orderedGateCommands(shuffledCatalogue()).map((command) => command.name),
    [...REQUIRED_GATE_NAMES],
  );
});
