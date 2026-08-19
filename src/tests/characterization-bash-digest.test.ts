// VQ-204 characterization (PAR-1): digestBashOutput byte-tikslių kontraktų runner'is prieš
// pažodinę AG_loop fixture kopiją. Įvestis eina per readBashToolResponse (kaip gyvame
// PostToolUse kelyje); digest'o `text` lyginamas kaip eilučių masyvas. Record režimo NĖRA.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { digestBashOutput } from "../domain/tool-results/digest/bash-output-digest.js";
import { readBashToolResponse } from "../domain/tool-results/bash-tool-response.js";

type DigestCase = {
  id: string;
  command: string;
  response?: { stdout_lines: string[]; stderr_lines: string[]; exit_code?: number };
  response_text_lines?: string[];
  expect: Record<string, unknown>;
};

type DigestFixture = { schema_version: number; record?: boolean; cases: DigestCase[] };

const fixturePath = path.resolve(
  process.cwd(),
  "src",
  "tests",
  "fixtures",
  "characterization",
  "bash-digest-contracts.json",
);

const fixture: DigestFixture = JSON.parse(await readFile(fixturePath, "utf8"));

function toolResponseValue(digestCase: DigestCase): unknown {
  if (digestCase.response_text_lines) return digestCase.response_text_lines.join("\n");
  const response = digestCase.response;
  if (!response) throw new Error(`${digestCase.id}: fixture case carries no response`);
  return {
    stdout: response.stdout_lines.join("\n"),
    stderr: response.stderr_lines.join("\n"),
    ...(response.exit_code === undefined ? {} : { exit_code: response.exit_code }),
  };
}

function runCase(digestCase: DigestCase): unknown {
  const reading = readBashToolResponse(toolResponseValue(digestCase));
  assert.ok(reading.ok, `${digestCase.id}: tool_response must be readable — ${reading.ok ? "" : reading.reason}`);
  const digest = digestBashOutput({ command: digestCase.command, response: reading.value });
  if (digest.status === "unsupported") {
    return { status: digest.status, commandClass: digest.commandClass, reason: digest.reason, rawChars: digest.rawChars };
  }
  return {
    status: digest.status,
    commandClass: digest.commandClass,
    rawChars: digest.rawChars,
    digestChars: digest.digestChars,
    text: digest.text.split("\n"),
    signals: digest.signals,
    safeToReplace: digest.safeToReplace,
    ...(digest.unsafeReason === undefined ? {} : { unsafeReason: digest.unsafeReason }),
  };
}

test("bash-digest fixture is well-formed (schema v1, unique ids)", () => {
  assert.equal(fixture.schema_version, 1);
  assert.ok(fixture.cases.length >= 8, "fixture must keep its recorded coverage");
  const ids = fixture.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "case ids must be unique");
});

for (const digestCase of fixture.cases) {
  test(`bash digest contract: ${digestCase.id}`, () => {
    const actual = JSON.parse(JSON.stringify(runCase(digestCase)));
    assert.deepStrictEqual(actual, digestCase.expect, digestCase.id);
  });
}
