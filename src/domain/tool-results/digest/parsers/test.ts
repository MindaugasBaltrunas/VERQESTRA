// test klasės parser'is: node:test (TAP + spec reporters), vitest, jest. Behaviour etalon:
// AG_loop domain/tool-results/bash-output-digest.ts (parseTestOutput; WBR VQ-204 skaidymas).

import { emptyParse, type ClassParse } from "../model.js";
import { isLocationSource } from "../scan.js";
import { collectExpectation, extractLocations, pushName, readCount } from "../extraction.js";

const TAP_NOT_OK = /^\s*not ok\s+\d+\s*-?\s*(.*)$/;
const TAP_PASS_COUNT = /^\s*#\s*pass\s+(\d+)\s*$/;
const TAP_FAIL_COUNT = /^\s*#\s*fail\s+(\d+)\s*$/;
const SPEC_PASS_COUNT = /^\s*(?:ℹ\s*)?pass\s+(\d+)\s*$/;
const SPEC_FAIL_COUNT = /^\s*(?:ℹ\s*)?fail\s+(\d+)\s*$/;
const SPEC_FAILED_TEST = /^\s*[✖✗×]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/;
const VITEST_FAIL_FILE = /^\s*(?:❯\s+)?FAIL\s+(\S.*?)\s*$/;
const VITEST_TESTS_COUNT = /^\s*Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/;
const JEST_TESTS_COUNT = /^\s*Tests:\s+(?:(\d+)\s+failed,\s*)?(\d+)\s+passed/;
const YAML_EXPECTED = /^\s*expected:\s*(.+?)\s*$/;
const YAML_ACTUAL = /^\s*actual:\s*(.+?)\s*$/;
const DIFF_EXPECTED = /^\s*[-]?\s*Expected:?\s+(.+?)\s*$/;
const DIFF_RECEIVED = /^\s*[+]?\s*(?:Received|Actual):?\s+(.+?)\s*$/;
const YAML_ERROR_CODE = /^\s*code:\s*'?([A-Z][A-Z0-9_]*)'?\s*$/;
const ERR_CODE_TOKEN = /\b(ERR_[A-Z0-9_]+)\b/g;

export function parseTestOutput(lines: string[]): ClassParse {
  const parse = emptyParse();
  const expected: string[] = [];
  const actual: string[] = [];

  for (const line of lines) {
    const notOk = TAP_NOT_OK.exec(line);
    if (notOk) {
      parse.recognized = true;
      parse.failureEvidence = true;
      pushName(parse.failedNames, notOk[1]);
      continue;
    }

    const failedSpec = SPEC_FAILED_TEST.exec(line);
    if (failedSpec && !failedSpec[1]?.endsWith(":")) {
      parse.recognized = true;
      parse.failureEvidence = true;
      pushName(parse.failedNames, failedSpec[1]);
      continue;
    }

    const failFile = VITEST_FAIL_FILE.exec(line);
    if (failFile) {
      parse.recognized = true;
      parse.failureEvidence = true;
      pushName(parse.failedNames, failFile[1]);
      continue;
    }

    if (readCount(line, TAP_PASS_COUNT, 1, (value) => (parse.counts.pass = value))) parse.recognized = true;
    if (readCount(line, SPEC_PASS_COUNT, 1, (value) => (parse.counts.pass = value))) parse.recognized = true;
    if (
      readCount(line, TAP_FAIL_COUNT, 1, (value) => (parse.counts.fail = value)) ||
      readCount(line, SPEC_FAIL_COUNT, 1, (value) => (parse.counts.fail = value))
    ) {
      parse.recognized = true;
      if ((parse.counts.fail ?? 0) > 0) parse.failureEvidence = true;
      else parse.successEvidence = true;
    }

    for (const summary of [VITEST_TESTS_COUNT, JEST_TESTS_COUNT]) {
      const match = summary.exec(line);
      if (!match) continue;
      parse.recognized = true;
      const failed = Number(match[1] ?? 0);
      parse.counts.fail = failed;
      parse.counts.pass = Number(match[2]);
      if (failed > 0) parse.failureEvidence = true;
      else parse.successEvidence = true;
    }

    collectExpectation(line, YAML_EXPECTED, expected);
    collectExpectation(line, DIFF_EXPECTED, expected);
    collectExpectation(line, YAML_ACTUAL, actual);
    collectExpectation(line, DIFF_RECEIVED, actual);

    const yamlCode = YAML_ERROR_CODE.exec(line);
    if (yamlCode?.[1]) parse.errorCodes.push(yamlCode[1]);
    for (const token of line.matchAll(ERR_CODE_TOKEN)) {
      if (token[1]) parse.errorCodes.push(token[1]);
    }

    // Only diagnostic lines and failure stacks contribute locations. A green run that merely
    // lists its test files would otherwise fill the location cap and flag its own digest unsafe.
    if (isLocationSource(line)) parse.locations.push(...extractLocations(line));
  }

  for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
    parse.expectations.push({ expected: expected[index] ?? "", actual: actual[index] ?? "" });
  }

  return parse;
}
