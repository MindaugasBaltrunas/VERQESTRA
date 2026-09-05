// VQ-305 (2/3-c): security-verify + spec-drift use case'ų, security/spec/model loaderių ir
// stream-json marker skaitytojo unit testai. Fake portai — jokio realaus FS/git.
import assert from "node:assert/strict";
import test from "node:test";
import {
  extractResultEnvelopeFromStreamJsonLog,
  logHasAlreadyImplementedMarker,
  logHasAuditCompleteMarker,
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

  // 2026-08-30 (072 antras bėgimas): vykdytojas markerį įvyniojo į markdown bold ir sąžiningas
  // ALREADY_IMPLEMENTED parkavosi human-review. Markdown įvyniojimas eilutės pradžioje toleruojamas;
  // markeris teksto VIDURYJE (ne eilutės pradžioje) tebeatmetamas.
  assert.equal(logHasAlreadyImplementedMarker("**ALREADY_IMPLEMENTED**: darbas jau kode\n"), true);
  assert.equal(logHasAlreadyImplementedMarker("`ALREADY_IMPLEMENTED`: žr. failą\n"), true);
  assert.equal(logHasAuditCompleteMarker("**AUDIT_COMPLETE**: radinių nėra\n"), true);
  assert.equal(logHasAlreadyImplementedMarker("žodis **ALREADY_IMPLEMENTED** viduryje"), false);

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

// Task 095: abu markeriai dalijasi ta pačia dviguba paieška (`logHasLineStartMarker`), tad
// refaktoringas galėtų juos sulieti nepastebimai. Šis testas laiko juos atskirus: kiekvienas
// atpažįsta TIK savo žodį, o `RegExp.test` be `g` vėliavos neneša būsenos tarp kvietimų —
// tas pats log'as antrą kartą privalo duoti tą patį atsakymą.
test("stream-log: ALREADY_IMPLEMENTED ir AUDIT_COMPLETE markeriai nesipainioja ir yra be būsenos", () => {
  const auditLog = "AUDIT_COMPLETE: radinių nėra\n";
  const alreadyLog = "ALREADY_IMPLEMENTED: darbas jau padarytas\n";

  assert.equal(logHasAuditCompleteMarker(auditLog), true);
  assert.equal(logHasAuditCompleteMarker(alreadyLog), false);
  assert.equal(logHasAlreadyImplementedMarker(alreadyLog), true);
  assert.equal(logHasAlreadyImplementedMarker(auditLog), false);

  assert.equal(logHasAuditCompleteMarker(auditLog), true, "antras kvietimas duoda tą patį");
  assert.equal(logHasAlreadyImplementedMarker(alreadyLog), true, "antras kvietimas duoda tą patį");
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

/** Node FS klaidos forma: sprendimą lemia `code`, ne žinutės tekstas. */
function errnoError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function makeSecurityPorts(input: {
  policy?: { blocked_file_patterns: string[]; dangerous_code_patterns: string[]; no_secrets_in_repo: boolean };
  changed?: string[];
  files?: Record<string, string>;
  /** Keliai, kurie EGZISTUOJA, bet neįskaitomi (teisės, katalogas) — atskirai nuo ištrintų. */
  unreadableButPresent?: string[];
  /**
   * Keliai, kurie EGZISTUOJA ir neįskaitomi, BET `statPathKind` apie juos sako „absent" —
   * tikslus `nodeFsAdapter.statKind` elgesys, kai pats stat krenta EPERM/EACCES (klaida ryjama).
   */
  unreadableWithStatSwallowingError?: string[];
  /** Keliai, kuriems pats `statPathKind` portas META klaidą (FS lūžis stat kelyje). */
  statRejects?: string[];
}): { ports: SecurityVerifyPorts; results: SecurityVerifyResult[] } {
  const results: SecurityVerifyResult[] = [];
  const contents = new Map(Object.entries(input.files ?? {}));
  const present = input.unreadableButPresent ?? [];
  const presentButStatLies = input.unreadableWithStatSwallowingError ?? [];
  const statRejects = input.statRejects ?? [];
  const matches = (suffixes: string[], normalized: string): boolean =>
    suffixes.some((suffix) => normalized.endsWith(suffix));
  const ports: SecurityVerifyPorts = {
    loadPolicy: async () =>
      input.policy ?? { blocked_file_patterns: [".env"], dangerous_code_patterns: ["eval("], no_secrets_in_repo: true },
    changedFiles: async () => input.changed ?? [],
    readTextFile: async (absolutePath) => {
      const normalized = absolutePath.replace(/\\/g, "/");
      const hit = [...contents.entries()].find(([suffix]) => normalized.endsWith(suffix));
      if (hit) return hit[1];
      // Tebeegzistuojantis failas duoda teisių klaidą, ištrintas — ENOENT: būtent šis skirtumas
      // (o ne stat rezultatas) yra vartui prieinamas įrodymas.
      if (matches(present, normalized) || matches(presentButStatLies, normalized)) {
        throw errnoError("EACCES", `permission denied, open '${normalized}'`);
      }
      throw errnoError("ENOENT", `no such file or directory, open '${normalized}'`);
    },
    statPathKind: async (absolutePath) => {
      const normalized = absolutePath.replace(/\\/g, "/");
      if (matches(statRejects, normalized)) throw errnoError("EPERM", `operation not permitted, stat '${normalized}'`);
      return matches(present, normalized) ? "file" : "absent";
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

// 2026-09-01 auditas (P2): ta pati apsauga turėjo spragą PO savimi. Sprendimą lėmė
// `statPathKind(...).catch(() => "absent")`, o `nodeFsAdapter.statKind` ir pats VISAS stat klaidas
// ryja į `"absent"` — tad EPERM ant stat kelio grąžindavo „failo nėra", ir tebeegzistuojantis,
// NENUSKENUOTAS failas gaudavo tik warning → exit 0. Dabar sprendžia skaitymo `errno` kodas.
test("securityVerify: stat klaida ir jos rijimas į absent nebėra leidimas neperskaitytam failui", async () => {
  // (1) Produkcijos atvejis 1:1: skaitymas EACCES, o statKind apie tą patį kelią sako „absent",
  // nes stat krito EPERM ir adapteris klaidą prarijo. Sena logika: kind === "absent" → warning.
  const swallowed = makeSecurityPorts({
    changed: ["src/locked.ts"],
    files: {},
    unreadableWithStatSwallowingError: ["src/locked.ts"],
  });
  const swallowedResult = await securityVerify(swallowed.ports, [], "/repo");
  assert.equal(swallowedResult.status, "blocked", "melaginga absent reikšmė nebeperduoda sprendimo");
  assert.deepEqual(swallowedResult.blocked_paths, [{ file: "src/locked.ts", pattern: "unreadable" }]);

  // (2) Portas, kuris stat klaidos NEryja, o meta: dvigubas nepavykimas irgi yra nežinia → blokas.
  const rejecting = makeSecurityPorts({
    changed: ["src/locked.ts"],
    files: {},
    unreadableWithStatSwallowingError: ["src/locked.ts"],
    statRejects: ["src/locked.ts"],
  });
  assert.equal((await securityVerify(rejecting.ports, [], "/repo")).status, "blocked");

  // (3) ENOENT + krentantis stat: net kai skaitymas sako „nebėra", nepatvirtintas kelias blokuojamas.
  const goneButStatBroken = makeSecurityPorts({
    changed: ["src/gone.ts"],
    files: {},
    statRejects: ["src/gone.ts"],
  });
  const goneResult = await securityVerify(goneButStatBroken.ports, [], "/repo");
  assert.equal(goneResult.status, "blocked");
  assert.deepEqual(goneResult.blocked_paths, [{ file: "src/gone.ts", pattern: "unreadable" }]);

  // (4) Neatpažinta skaitymo klaida (be `errno` kodo) — irgi nežinia, ne ištrynimas.
  const noCode = makeSecurityPorts({ changed: ["src/weird.ts"], files: {} });
  const opaque: SecurityVerifyPorts = {
    ...noCode.ports,
    readTextFile: async () => {
      throw new Error("something went wrong");
    },
  };
  assert.equal((await securityVerify(opaque, [], "/repo")).status, "blocked");
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

test("specDrift: glob su žvaigždute scope viduryje atitinka failus (SD-1)", async () => {
  // Iki 2026-09-05 audito toks scope turėjo '/', bet nesibaigė '/**', tad krisdavo į prefikso
  // palyginimą ir NIEKADA neatitikdavo — kiekvienas pakeitimas virsdavo `review-required`.
  const globScope = ["src/**/*.ts"];
  assert.equal(isFileInScope("src/a/b.ts", globScope), true);
  assert.equal(isFileInScope("src/a.ts", globScope), true, "'**/' reiškia ir nulį katalogų");
  assert.equal(isFileInScope("src/a/b.tsx", globScope), false, "sufiksas vis dar riboja");
  assert.equal(isFileInScope("docs/a.ts", globScope), false);
  assert.equal(isFileInScope("ui-app/src/x.tsx", ["ui-app/src/**/*.tsx"]), true);
  assert.equal(isFileInScope("src/application/x.ts", ["src/application/*"]), true, "'/*' — vienas lygis");
  assert.equal(isFileInScope("src/application/a/x.ts", ["src/application/*"]), false);

  const scoped = makeSpecPorts({ scope: globScope, changed: ["src/a/b.ts", "src/c.ts"] });
  const result = await specDrift(scoped.ports, ["ch-1"], "/repo");
  assert.equal(result.status, "ok");
  assert.deepEqual(result.outside_scope, []);

  // Prefikso forma (be žvaigždutės) elgiasi kaip iki šiol.
  assert.equal(isFileInScope("docs/spec-workflow.md", ["docs/"]), true);
  assert.equal(isFileInScope("docsy/x.md", ["docs/"]), false);
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
