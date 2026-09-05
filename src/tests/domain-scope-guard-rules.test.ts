// Task 200 testai — `backendLineRules` exec taisyklė. Pinamas dalykas yra vienas: BLOCK
// šauna TIK shell vykdymo kontekste, o `RegExp.prototype.exec` metodo kvietimas jokiu pavidalu
// nėra radinys. Etalono `\bexec\s*\(` čia klydo (pilnas auditas 2026-09-05, D3): `\b` tarp `.`
// ir `e` YRA žodžio riba, tad `pattern.exec(line)` blokuodavo kiekvieną regex'ą naudojantį
// backend failą.
//
// Testuojama per `scanLineRules` — tokį pat kelią, kokį naudoja guard'o adapteris; helperis
// `usesShellExecWithVariableInput` sąmoningai lieka modulio viduje (eksportas be produkcinio
// kvietėjo praeitų dead-export vartus tik dėl testo).

import assert from "node:assert/strict";
import { test } from "node:test";
import { backendLineRules, scanLineRules } from "../domain/policies/index.js";

const BACKEND_FILE = "apps/api/src/routes/x.ts";

function scan(line: string): { findings: string[]; blocked: boolean } {
  return scanLineRules(BACKEND_FILE, `${line}\n`, [...backendLineRules]);
}

function execFindings(line: string): string[] {
  return scan(line).findings.filter((finding) => finding.includes("child_process.exec"));
}

function assertBlocked(line: string): void {
  const result = scan(line);
  assert.equal(result.blocked, true, `tikėtasi BLOCK: ${line}`);
  assert.ok(
    result.findings.some(
      (finding) => finding.includes("BLOCK") && finding.includes("uses child_process.exec with variable"),
    ),
    `tikėtasi exec radinio: ${line}`,
  );
}

function assertNoExecFinding(line: string): void {
  assert.deepEqual(execFindings(line), [], `tikėtasi jokio exec radinio: ${line}`);
  assert.equal(scan(line).blocked, false, `tikėtasi jokio BLOCK: ${line}`);
}

test("exec taisyklė: RegExp.prototype.exec metodo kvietimas nėra radinys", () => {
  assertNoExecFinding("const match = pattern.exec(line);");
  assertNoExecFinding("const match = re.exec(req.body.dir);");
  assertNoExecFinding("const id = TASK_ID_PATTERN.exec(message)?.[1];");
  assertNoExecFinding("  const parsed = /^(\\w+)$/.exec(value);");
});

test("exec taisyklė: `child_process` žodis eilutėje nepaverčia metodo kvietimo bloku", () => {
  // (c) forma reikalauja exec KVIETIMO, ne vien modulio vardo — kitaip komentaras apie
  // child_process vėl uždarytų kiekvieną regex'ą naudojantį failą.
  assertNoExecFinding("// child_process nenaudojamas: TASK_ID_PATTERN.exec(message)");
});

test("exec taisyklė: plikas shell kvietimas su kintamu įėjimu blokuoja", () => {
  assertBlocked("exec(`ls ${req.body.dir}`)");
  assertBlocked("exec(cmd)");
  assertBlocked('execSync("ls " + req.query.dir)');
  assertBlocked("await execFile(userCommand, args)");
});

test("exec taisyklė: `child_process` receiveris blokuoja besąlygiškai", () => {
  assertBlocked("child_process.exec(cmd)");
  assertBlocked("cp.execSync(userCmd)");
  assertBlocked("childProcess.execFile(bin, args)");
  assertBlocked('require("child_process").exec(userCmd)');
});

test("exec taisyklė: `child_process` importas toje pačioje eilutėje panaikina literalo išimtį", () => {
  assertBlocked('const { exec } = require("child_process"); exec(cmd)');
  assertBlocked('import { execSync } from "node:child_process"; execSync("ls -la")');
});

test("exec taisyklė: fiksuota komanda be shell modulio nėra radinys", () => {
  assertNoExecFinding('execSync("ls -la")');
  assertNoExecFinding("execSync('git status')");
  assertNoExecFinding("execSync(`git status`)");
});

test("exec taisyklė: kitos backend heuristikos lieka WARN, ne BLOCK", () => {
  const result = scan("console.log(pattern.exec(line));");
  assert.equal(result.blocked, false);
  assert.ok(result.findings.some((finding) => finding.includes("WARN") && finding.includes("console.log")));
});
