// VQ-305 (2/3-c): security-verify + spec-drift use case'ų, security/spec/model loaderių ir
// stream-json marker skaitytojo unit testai. Fake portai — jokio realaus FS/git.
import assert from "node:assert/strict";
import test from "node:test";
import {
  extractResultEnvelopeFromStreamJsonLog,
  logHasAlreadyImplementedMarker,
} from "../domain/diagnosis/stream-log.js";
import {
  loadSecurityPolicy,
  loadSpecPolicy,
  securityPolicySchema,
} from "../application/policy-governance/security-spec-policies.js";
import { loadModelPolicy } from "../application/policy-governance/model-policy.js";
import {
  isTestOrFixtureFile,
  matchesBlockedPathPattern,
  matchesDangerousPattern,
  securityVerify,
  type SecurityVerifyPorts,
  type SecurityVerifyResult,
} from "../application/quality-gates/security-verify.js";
import {
  isFileInScope,
  parseProvidedFiles,
  specDrift,
  type SpecDriftPorts,
  type SpecDriftResult,
} from "../application/quality-gates/spec-drift.js";

test("stream-log: markeris randamas plain-text ir stream-json envelope, o JSON stringo viduryje — ne", () => {
  assert.equal(logHasAlreadyImplementedMarker("ALREADY_IMPLEMENTED: viskas yra\n"), true);
  assert.equal(logHasAlreadyImplementedMarker("  ALREADY_IMPLEMENTED viduje eilutės\n"), true);
  assert.equal(logHasAlreadyImplementedMarker(""), false);
  assert.equal(logHasAlreadyImplementedMarker("tekstas be markerio"), false);

  // Etalono 1048/1049 pamoka: stream-json log'e markeris gyvena result lauke su tikrais \n.
  const streamLog = [
    '{"type":"system","noise":true}',
    "stderr triukšmas",
    `{"type":"result","result":"Peržiūra baigta.\\nALREADY_IMPLEMENTED: darbas jau padarytas."}`,
  ].join("\n");
  assert.equal(logHasAlreadyImplementedMarker(streamLog), true);
  assert.equal(
    logHasAlreadyImplementedMarker('{"type":"result","result":"tekste minimas ALREADY_IMPLEMENTED žodis"}'),
    false,
    "markeris turi prasidėti eilutės pradžioje ir result lauke",
  );

  const envelope = extractResultEnvelopeFromStreamJsonLog(streamLog);
  assert.equal(envelope?.["type"], "result");
  assert.equal(extractResultEnvelopeFromStreamJsonLog("jokio result"), undefined);
});

function fakeFs(files: Record<string, string>): { readTextFileIfExists: (p: string) => Promise<string | undefined> } {
  const map = new Map(Object.entries(files));
  return { readTextFileIfExists: async (p) => map.get(p.replace(/\\/g, "/")) };
}

test("security/spec/model loaderiai: trūkstamas failas — KLAIDA; deprecated laukai — sink'as", async () => {
  await assert.rejects(() => loadSecurityPolicy(fakeFs({}), "/repo/vq"), /security-policy not found/);
  await assert.rejects(() => loadSpecPolicy(fakeFs({}), "/repo/vq"), /spec-policy not found/);
  await assert.rejects(() => loadModelPolicy(fakeFs({}), "/repo/vq"), /model policy not found/);

  const security = await loadSecurityPolicy(
    fakeFs({ "/repo/vq/config/security-policy.json": '{"blocked_file_patterns":[".env"]}' }),
    "/repo/vq",
  );
  assert.deepEqual(security.blocked_file_patterns, [".env"]);
  assert.equal(security.no_secrets_in_repo, true, "default'ai užpildomi");
  assert.equal(securityPolicySchema.parse({}).dangerous_code_patterns.length, 0);

  const warnings: string[] = [];
  const model = await loadModelPolicy(
    fakeFs({ "/repo/vq/config/model-policy.json": '{"tiers":["sonnet"],"escalation":{}}' }),
    "/repo/vq",
    (message) => warnings.push(message),
  );
  assert.deepEqual(model.tiers, ["sonnet"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /pasenusius laukus \(escalation\)/);
});

test("security-verify grynos taisyklės: pattern formos, case taisyklė, test/fixture praleidimas", () => {
  assert.equal(matchesBlockedPathPattern("src/env.ts", "*.env"), false);
  assert.equal(matchesBlockedPathPattern("config/prod.env", "*.env"), true);
  assert.equal(matchesBlockedPathPattern("vq/state/x.json", "vq/state/**"), true);
  assert.equal(matchesBlockedPathPattern("a/b/.env.local", ".env.*"), true);
  assert.equal(matchesBlockedPathPattern("deep/dir/id_rsa", "id_rsa"), true);

  // PC-SEC-02: didžiosios raidės — case-sensitive, mažosios — insensitive.
  assert.equal(matchesDangerousPattern("new Function('x')", "Function("), true);
  assert.equal(matchesDangerousPattern("function(x) {}", "Function("), false);
  assert.equal(matchesDangerousPattern("PowerShell -Enc abc", "powershell -enc"), true);

  assert.equal(isTestOrFixtureFile("src/tests/x.ts"), true);
  assert.equal(isTestOrFixtureFile("src/app.test.ts"), true);
  assert.equal(isTestOrFixtureFile("src/app.ts"), false);
});

function makeSecurityPorts(input: {
  policy?: { blocked_file_patterns: string[]; dangerous_code_patterns: string[]; no_secrets_in_repo: boolean };
  changed?: string[];
  files?: Record<string, string>;
  /** Keliai, kurie EGZISTUOJA, bet neįskaitomi (teisės, katalogas) — atskirai nuo ištrintų. */
  unreadableButPresent?: string[];
}): { ports: SecurityVerifyPorts; results: SecurityVerifyResult[] } {
  const results: SecurityVerifyResult[] = [];
  const contents = new Map(Object.entries(input.files ?? {}));
  const present = input.unreadableButPresent ?? [];
  const ports: SecurityVerifyPorts = {
    loadPolicy: async () =>
      input.policy ?? { blocked_file_patterns: [".env"], dangerous_code_patterns: ["eval("], no_secrets_in_repo: true },
    changedFiles: async () => input.changed ?? [],
    readTextFile: async (absolutePath) => {
      const normalized = absolutePath.replace(/\\/g, "/");
      const hit = [...contents.entries()].find(([suffix]) => normalized.endsWith(suffix));
      if (!hit) throw new Error(`ENOENT: ${normalized}`);
      return hit[1];
    },
    statPathKind: async (absolutePath) => {
      const normalized = absolutePath.replace(/\\/g, "/");
      return present.some((suffix) => normalized.endsWith(suffix)) ? "file" : "absent";
    },
    writeResult: async (result) => void results.push(result),
  };
  return { ports, results };
}

test("securityVerify: pavojingas kodas ir blokuoti keliai → blocked; test failai praleidžiami", async () => {
  const { ports, results } = makeSecurityPorts({
    changed: ["src/app.ts", "src/app.test.ts", "config/.env"],
    files: { "src/app.ts": "const x = eval('2+2');\n", "src/app.test.ts": "eval('testuose leidžiama');\n" },
  });
  const result = await securityVerify(ports, [], "/repo");
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blocked_paths, [{ file: "config/.env", pattern: ".env" }]);
  assert.equal(result.text_findings.length, 1, "test failas praleistas, app.ts rastas");
  assert.deepEqual(result.text_findings[0], { file: "src/app.ts", line: 1, pattern: "eval(", text: "const x = eval('2+2');" });
  assert.equal(result.result_path, "vq/state/security-verify-result.json");
  assert.equal(results.length, 1, "rezultatas persistuotas per portą");
});

test("securityVerify: švarus failas → ok; eksplicitinis neperskaitomas/už root'o → blocked", async () => {
  const clean = makeSecurityPorts({ changed: ["src/ok.ts"], files: { "src/ok.ts": "const a = 1;\n" } });
  assert.equal((await securityVerify(clean.ports, [], "/repo")).status, "ok");

  const empty = makeSecurityPorts({ changed: [] });
  const emptyResult = await securityVerify(empty.ports, [], "/repo");
  assert.equal(emptyResult.status, "blocked", "be failų — fail-closed blocked");
  assert.ok(emptyResult.warnings.includes("no files provided and no changed files detected"));

  const unreadable = makeSecurityPorts({ files: {} });
  const unreadableResult = await securityVerify(unreadable.ports, ["src/missing.ts"], "/repo");
  assert.equal(unreadableResult.status, "blocked");
  assert.deepEqual(unreadableResult.blocked_paths, [{ file: "src/missing.ts", pattern: "unreadable" }]);

  const outside = makeSecurityPorts({ files: {} });
  const outsideResult = await securityVerify(outside.ports, ["../evil.ts"], "/repo");
  assert.equal(outsideResult.status, "blocked");
  assert.equal(outsideResult.blocked_paths[0]?.pattern, "outside-project");
});

// 2026-08-24 auditas (vartų sluoksnis): „neperskaitėme" turėjo DVI priežastis ir vieną atsakymą.
// Neaiškiai (ne `explicit`) atkeliavęs pakeistas failas, kurio nepavyko perskaityti, likdavo
// NENUSKENUOTAS, o `warning` grąžina exit 0 (`blocked ? 1 : 0`) — nežinia virsdavo leidimu.
test("securityVerify: EGZISTUOJANTIS bet neįskaitomas pakeistas failas blokuoja, ištrintas — ne", async () => {
  // Ištrintas pakeistas failas: turinio nebėra, tad skenuoti nėra ko — blokuoti būtų neteisinga.
  const deleted = makeSecurityPorts({ changed: ["src/deleted.ts"], files: {} });
  const deletedResult = await securityVerify(deleted.ports, [], "/repo");
  assert.equal(deletedResult.status, "warning", "ištrintas failas nėra rizika");
  assert.deepEqual(deletedResult.blocked_paths, []);
  assert.ok(deletedResult.warnings.some((line) => line.includes("src/deleted.ts")), "priežastis vis tiek matoma");

  // Tas pats neperskaitymas, bet failas TEBEEGZISTUOJA (teisės, katalogas, laikina FS klaida):
  // jo turinys nepatikrintas, tad vartas privalo blokuoti, o ne praleisti su įspėjimu.
  const locked = makeSecurityPorts({ changed: ["src/locked.ts"], files: {}, unreadableButPresent: ["src/locked.ts"] });
  const lockedResult = await securityVerify(locked.ports, [], "/repo");
  assert.equal(lockedResult.status, "blocked");
  assert.deepEqual(lockedResult.blocked_paths, [{ file: "src/locked.ts", pattern: "unreadable" }]);
});

function makeSpecPorts(input: {
  scope?: unknown;
  changed?: string[];
  missingChange?: boolean;
}): { ports: SpecDriftPorts; results: SpecDriftResult[] } {
  const results: SpecDriftResult[] = [];
  const ports: SpecDriftPorts = {
    assertSpecPolicy: async () => {},
    readSpecChange: async (changeId) => {
      if (input.missingChange) throw new Error(`Spec change not found: ${changeId}`);
      return { id: changeId, scope: input.scope };
    },
    changedFiles: async () => input.changed ?? [],
    writeResult: async (result) => void results.push(result),
  };
  return { ports, results };
}

test("specDrift: scope formos ir verdiktai — ok / review-required / warning", async () => {
  const ok = makeSpecPorts({ scope: ["src/feature/**"], changed: ["src/feature/a.ts", "src/feature/b/c.ts"] });
  const okResult = await specDrift(ok.ports, ["ch-1"], "/repo");
  assert.equal(okResult.status, "ok");
  assert.deepEqual(okResult.outside_scope, []);
  assert.equal(okResult.result_path, "vq/state/spec-drift-result.json");

  const drift = makeSpecPorts({ scope: ["src/feature/**"], changed: ["src/kitas/x.ts"] });
  const driftResult = await specDrift(drift.ports, ["ch-1"], "/repo");
  assert.equal(driftResult.status, "review-required");
  assert.deepEqual(driftResult.outside_scope, ["src/kitas/x.ts"]);

  const emptyScope = makeSpecPorts({ scope: [], changed: [] });
  const warningResult = await specDrift(emptyScope.ports, ["ch-1"], "/repo");
  assert.equal(warningResult.status, "warning");
  assert.ok(warningResult.warnings.includes("spec change scope is empty"));

  // Fragmentinis scope be '/': visi brūkšnio fragmentai turi būti faile.
  assert.equal(isFileInScope("src/task-splitter.ts", ["task-split"]), true);
  assert.equal(isFileInScope("src/kitas.ts", ["task-split"]), false);
  assert.equal(isFileInScope("bet/koks.ts", ["**"]), true);
});

test("specDrift: --files= argumentai nugali git sąrašą; trūkstamas change meta klaidą", async () => {
  const { ports } = makeSpecPorts({ scope: ["src/**"], changed: ["kitas/is-git.ts"] });
  const result = await specDrift(ports, ["ch-1", "--files=src/a.ts,src/b.ts"], "/repo");
  assert.deepEqual(result.files, ["src/a.ts", "src/b.ts"], "eksplicitiniai failai naudojami vietoje git");
  assert.equal(result.status, "ok");
  assert.deepEqual(parseProvidedFiles(["--files=a,b", "c", "--kitas"]), ["a", "b", "c"]);

  const missing = makeSpecPorts({ missingChange: true });
  await assert.rejects(() => specDrift(missing.ports, ["nėra"], "/repo"), /Spec change not found: nėra/);
  await assert.rejects(() => specDrift(missing.ports, [], "/repo"), /Usage: verqestra spec-drift/);
});
