// VARTAS: kiekvienas produkcinis eksportas turi turėti kvietėją — arba įvardintą priežastį.
//
// Kodėl jis atsirado (2026-08-23/24 auditai). Du epikai iš eilės baigėsi tuo pačiu radiniu:
// modulis migruotas, testais apkabintas, o composition jo taip ir neprijungė. Pavyzdžiai —
// `planTaskWorktree`, `runGitPlan`, `GitCommandPlan`: visi trys atrodė gyvi, nes vienas kitą
// naudojo, o už tos grandinės nebuvo nieko. Toks kodas blogesnis už jo nebuvimą: jis atrodo
// kaip veikianti savybė ir eina į priėmimo ataskaitą kaip padarytas darbas.
//
// Rankinė patikra tam netinka. Ji buvo bandyta ir SUKLYDO trimis skirtingais būdais:
//   1. `grep | head -5` nukirpo tikrą kvietėją, ir gyvas vartas buvo paskelbtas mirusiu;
//   2. komentaro paminėjimas buvo palaikytas kvietimu;
//   3. `/*` EILUTĖS komentaro viduje (`// rašytojas į vq/runtime/**`) atidarė bloką, kurio
//      niekas neatidarė, ir regex prarijo 68 eilutes kartu su tikru importu.
// Visos trys — ta pati klaida: nukirpta evidencija. Vartas jos nedaro, nes nieko nekerpa.
//
// Vartas NĖRA draudimas turėti neprijungtą kodą. Jis reikalauja, kad neprijungtas kodas būtų
// SURAŠYTAS su priežastimi: nauja eilutė sąraše yra sąmoningas sprendimas, o ne nutylėjimas.
// Priešinga kryptis irgi tikrinama — prijungus simbolį jo eilutė privalo iš sąrašo dingti,
// kad sąrašas nevirstų senų pateisinimų muziejumi.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  collect,
  findOrphanFiles,
  importSpecifiers,
  resolveSpecifier,
  stripComments,
  type ScannedFile,
} from "./helpers/dead-export-gate-scan.js";

const SRC_ROOT = path.resolve(process.cwd(), "src");

/**
 * Failai, kurių joks kitas src failas neimportuoja per kelią — bet jie yra tikri įėjimo taškai
 * (bin, CLI shebang, ar kitaip kviečiami iš už TypeScript importų grafo ribų). Kiekvienas
 * įrašas su priežastimi — ta pati dviejų krypčių drausmė kaip KNOWN_UNCALLED žemiau: atsiradęs
 * importuotojas daro eilutę nebeteisingą, ir savipatikra tai gaudo.
 */
const KNOWN_ENTRYPOINTS: Readonly<Record<string, string>> = {
  // bin: dist/cli.js yra package.json `bin` taikinys ir hook'ų (pre/post) kvietimo taškas —
  // OS/npm jį paleidžia pagal kelią, ne pagal TS importą (README.md: "the only entrypoint").
  "cli.ts": "ENTRYPOINT: bin",
};

/**
 * BARREL — projekto plataus masto sutartis (kiekvieno `index.ts` antraštėje: "barrel —
 * re-exports only (MOD-1)"), ne šio incidento klasė. `shared/index.ts` antraštė ją įvardija
 * tiesiogiai: produkcinis kodas importuoja SESERIŠKUS failus GILIAIS keliais, o barrel'is
 * dokumentuoja modulio viešą paviršių — jo egzistavimas nepriklauso nuo to, ar kas nors jį
 * IMPORTUOJA. 2026-09-01 pjūvis rado 31 tokį failą visuose sluoksniuose (application, domain,
 * infrastructure, interfaces, composition, shared) — sisteminis, ne pavienis radinys.
 *
 * Skirtis nuo incidento, kurį šis vartas gaudo: `code-index-store.ts` buvo DVI skirtingos
 * REALIZACIJOS su tais pačiais eksportų vardais (viena mirusi), o šie barrel'iai yra VIENA
 * realizacija (re-export sąrašas) be tiesioginio importuotojo pagal kelią — architektūrinis
 * pasirinkimas, ne dublikato liekana.
 */
const KNOWN_ORPHAN_FILES: Readonly<Record<string, string>> = {
  "application/analytics/index.ts": "BARREL",
  "application/architecture/index.ts": "BARREL",
  "application/code-intelligence/index.ts": "BARREL",
  "application/context-pack/index.ts": "BARREL",
  "application/learning/index.ts": "BARREL",
  "application/policy-governance/index.ts": "BARREL",
  "application/project-bootstrap/index.ts": "BARREL",
  "application/quality-gates/index.ts": "BARREL",
  "application/release-readiness/index.ts": "BARREL",
  "application/task-planning/index.ts": "BARREL",
  "application/token-governance/index.ts": "BARREL",
  "composition/index.ts": "BARREL",
  "domain/agents/index.ts": "BARREL",
  "domain/diagnosis/index.ts": "BARREL",
  "domain/git/index.ts": "BARREL",
  "domain/tokens/index.ts": "BARREL",
  "infrastructure/index.ts": "BARREL",
  "interfaces/cli/admin/index.ts": "BARREL",
  "interfaces/cli/architecture/index.ts": "BARREL",
  "interfaces/cli/audit/index.ts": "BARREL",
  "interfaces/cli/benchmark/index.ts": "BARREL",
  "interfaces/cli/bootstrap/index.ts": "BARREL",
  "interfaces/cli/code-intel/index.ts": "BARREL",
  "interfaces/cli/dispatch/index.ts": "BARREL",
  "interfaces/cli/github/index.ts": "BARREL",
  "interfaces/cli/reports/index.ts": "BARREL",
  "interfaces/cli/spec/index.ts": "BARREL",
  "interfaces/cli/task-queue/index.ts": "BARREL",
  "interfaces/http/index.ts": "BARREL",
  "interfaces/ui-model/index.ts": "BARREL",
  "shared/index.ts": "BARREL",
};

/**
 * Eksportai be jokio kvietėjo — nei produkcijoje, nei testuose, nei savame faile.
 *
 * KIEKVIENA eilutė privalo turėti priežastį, ir priežastis yra dalis varto: be jos sąrašas
 * būtų tik skaičius, kurį kitas auditas vėl tirtų nuo nulio. Trys leistinos rūšys:
 *
 *   FORWARD — etalonas jo taip pat niekur nekviečia (dažnai turi tik testus). Perkelta kaip
 *   kontraktas, ne kaip savybė; ištrynimas būtų nukrypimas nuo etalono.
 *
 *   NEPRIJUNGTA — savybė, kurios composition dar nesuriša. Tai SKOLA, ne sprendimas: kai
 *   epikas ją prijungs, eilutė privalo dingti.
 *
 *   ŠEIMA — simetriško rinkinio narys (`readX`/`writeX`), kurio pusės ištrynimas paliktų
 *   API, kuris moka rašyti, bet nemoka perskaityti.
 */
const KNOWN_UNCALLED: Readonly<Record<string, string>> = {
  // ŠEIMA: `writeJsonArtifact`/`writeTextArtifact`/`appendUsageEntry` prijungti; skaitymo ir
  // log'o pusės ištrynimas paliktų store'ą, į kurį galima tik rašyti.
  "infrastructure/persistence/runtime-artifact-store.ts#readJsonArtifact": "ŠEIMA",
  "infrastructure/persistence/runtime-artifact-store.ts#readTextArtifact": "ŠEIMA",
  "infrastructure/persistence/runtime-artifact-store.ts#appendAttemptLog": "ŠEIMA",
  // ŠEIMA: `runtimeAggregateRootDir` → `workerDir` → `taskDir` → `attemptDir` yra kelio kopėčios;
  // dviejų pakopų iškirtimas paliktų skyles ten, kur kelias aprašytas kaip visuma.
  "infrastructure/runtime-paths.ts#runsDir": "ŠEIMA",
  "infrastructure/runtime-paths.ts#runDir": "ŠEIMA",
  // ŠEIMA: `formatWorkerId`/`formatAttemptId` prijungti, `formatAttemptRef` — to paties
  // formatuotojų rinkinio narys (etalone irgi tik testai).
  "application/scheduling/worker-limits.ts#formatAttemptRef": "ŠEIMA",
  // FORWARD: `shared/ids` antraštėje užrašytas E1 sprendimas — etalonas neturi NĖ VIENO
  // produkcinio importuotojo, modulis perkeltas kaip kontraktas ateičiai.
  "shared/ids.ts#createId": "FORWARD",
  "shared/ids.ts#isNonEmptyId": "FORWARD",
  // FORWARD: etalone irgi be produkcinio kvietėjo (padengti tik jo testais).
  "domain/policies/enforcement-level.ts#normalizeEnforcementLevel": "FORWARD",
  "domain/tokens/routing-tier.ts#compareRoutingTier": "FORWARD",
  "application/context-pack/compact-dsl/render.ts#renderCompactWorkerDslWhenEnabled": "FORWARD",
  "application/context-pack/mcp-capability-registry.ts#dispatchMcpCapabilitiesFromOfferedTools": "FORWARD",
  "domain/scheduling/scope-lock-rules.ts#pruneScopeLocks": "FORWARD",
  "domain/scheduling/scope-lock-rules.ts#EMPTY_SCOPE_LOCK_REGISTRY": "FORWARD",
  // NEPRIJUNGTA: `runWaveGates` pats neturi produkcinio kvietėjo, o `WaveGateReportStore` neturi
  // adapterio — bangos vartų įrodymas niekada neįrašomas. Kelio helper'is laukia to adapterio.
  "application/integration/run-wave-gates.ts#waveGateReportPath": "NEPRIJUNGTA",
  // NEPRIJUNGTA: etalonas jį kviečia (`cli.ts` hook-on-stop šakoje) — pasenusio dist atveju Stop
  // hook'as ten DEGRADUOJA su žurnalo įrašu. VERQESTRA dist šviežumą tikrina tik loop preconditions.
  "infrastructure/process/dist-freshness.ts#quarantineStaleDist": "NEPRIJUNGTA",
  // NEPRIJUNGTA: etalonas juos kviečia (`status` komanda; backlog audito komanda).
  "application/learning/token-analytics-snapshot.ts#readTokenAnalyticsSnapshot": "NEPRIJUNGTA",
  "application/release-readiness/backlog-audit.ts#auditBacklogDirectory": "NEPRIJUNGTA",
  // NEPRIJUNGTA: `symbolBearingLanguages` iš to paties failo prijungtas, šis predikatas — ne.
  "application/code-intelligence/indexing/language-capabilities.ts#ecmascriptExtensions": "NEPRIJUNGTA",
};

/**
 * Šis failas savęs neskaičiuoja kaip kvietėjo.
 *
 * `KNOWN_UNCALLED` raktai yra eilutės, kuriose kiekvienas simbolis paminėtas vardu, o
 * tokenizatorius eilučių turinio nemato kitaip nei bet kurio kito teksto. Be šios išimties
 * vartas PRIKELDAVO viską, ką pats surašė: pirmas paleidimas parodė nulį mirusių eksportų —
 * ne todėl, kad jų nebūtų, o todėl, kad juos įvardijo pats sąrašas.
 */
const GATE_FILE = "tests/dead-export-gate.test.ts";

const files: ScannedFile[] = [];
await collect(SRC_ROOT, "", files);

// SAVIPATIKRA. Be jos skeneris, kuris nieko neranda, atrodo lygiai taip pat kaip švarus repo —
// būtent taip pirmoji šio varto versija tyliai prarijo tikrą importą.
test("gate savipatikra: `/*` eilutės komentare nepraryja už jo einančio kodo", () => {
  const sample = ['// rašytojas į vq/runtime/** kelią', 'import { taskDir } from "./p.js";', "/* tikras", "blokas */", "const x = 1;"].join(
    "\n",
  );
  const stripped = stripComments(sample);
  assert.match(stripped, /\btaskDir\b/, "už netikro `/*` einantis importas privalo išlikti");
  assert.doesNotMatch(stripped, /tikras/, "tikras blokinis komentaras privalo dingti");
  assert.equal(stripped.split("\n").length, sample.split("\n").length, "eilučių skaičius nekinta");
  assert.match(stripComments('const a = "// ne komentaras";'), /ne komentaras/, "eilutėje `//` nėra komentaras");

  // REGEX literalai — antras tos pačios klasės radinys, užrakintas TIKRU atveju iš
  // `domain/tasks/size.ts`. Backtick'as regex'e nėra template eilutės pradžia, o `[^/*]`
  // viduje esantis `/*` nėra bloko pradžia. Abu variantai anksčiau prarydavo tikrą kvietimą.
  const withRegex = ['const norm = raw.replace(/^`+|`+$/g, "");', "const hit = norm.match(/^(apps\\/[^/*]+)/);", "callTarget(hit);"].join(
    "\n",
  );
  const strippedRegex = stripComments(withRegex);
  assert.match(strippedRegex, /\bcallTarget\b/, "regex literalas negali praryti už jo einančio kodo");
  assert.equal(strippedRegex.split("\n").length, withRegex.split("\n").length, "eilučių skaičius nekinta");
  // Dalyba NĖRA regex pradžia — kitaip `a / b` atidarytų literalą ir prarytų likutį.
  assert.match(stripComments("const ratio = total / count;\nconst after = 1;"), /\bafter\b/, "dalyba lieka dalyba");

  assert.ok(files.length > 0, "nerasta nė vieno šaltinio — skenavimo šaknis neteisinga");
});

test("gate: kiekvienas produkcinis eksportas turi kvietėją arba įvardintą priežastį", () => {
  const production = files.filter((file) => !file.isTest);
  const tests = files.filter((file) => file.isTest && file.relative !== GATE_FILE);

  const uncalled: string[] = [];
  for (const file of production) {
    for (const symbol of file.exported) {
      const usedElsewhere = production.some((other) => other !== file && other.counts.has(symbol));
      if (usedElsewhere) continue;
      if (tests.some((other) => other.counts.has(symbol))) continue;
      // Deklaracija pati duoda vieną paminėjimą; daugiau reiškia panaudojimą savame faile
      // (t. y. „perteklinis EKSPORTAS", o ne miręs kodas — šis vartas to neliečia).
      if ((file.counts.get(symbol) ?? 0) > 1) continue;
      uncalled.push(`${file.relative}#${symbol}`);
    }
  }

  const known = Object.keys(KNOWN_UNCALLED);
  const appeared = uncalled.filter((entry) => !known.includes(entry)).sort();
  const disappeared = known.filter((entry) => !uncalled.includes(entry)).sort();

  assert.deepEqual(
    appeared,
    [],
    "naujas eksportas be kvietėjo. Prijunk jį arba įrašyk į KNOWN_UNCALLED su priežastimi " +
      "(FORWARD / NEPRIJUNGTA / ŠEIMA) — tylus praleidimas yra būtent tai, ką šis vartas gaudo",
  );
  assert.deepEqual(
    disappeared,
    [],
    "šie KNOWN_UNCALLED įrašai nebeteisingi: simbolis prijungtas arba ištrintas. Išbrauk eilutę — " +
      "pasenęs pateisinimas dengia kitą tokį patį radinį",
  );
});

test("gate savipatikra: specifikatorių ištraukimas ir kelio rezoliucija", () => {
  const source = [
    'import { x } from "./sibling.js";',
    'export * from "./barrel-target.js";',
    'const loader = () => import("../other/dynamic.js");',
    'const external = await import("typescript");',
  ].join("\n");
  const specifiers = importSpecifiers(stripComments(source));
  assert.deepEqual(
    [...specifiers].sort(),
    ["../other/dynamic.js", "./barrel-target.js", "./sibling.js"],
    "paketo specifikatorius (`typescript`) neturi patekti — tik santykiniai keliai",
  );
  assert.equal(resolveSpecifier("application/store/index.ts", "./sibling.js"), "application/store/sibling.ts");
  assert.equal(resolveSpecifier("application/store/index.ts", "../other/dynamic.js"), "application/other/dynamic.ts");
});

/**
 * Incidento klasė (2026-09-01): `code-index-store.ts` dubliuotas dviejose vietose, kanoninis
 * turėjo kvietėjus, o našlaitis buvo BENDRAVARDIS — simbolių lygio vartas jo nematė, nes
 * `usedElsewhere` tikrina VARDĄ, ne kelią. Failų lygio patikra tokį atvejį mato, nes tikrina
 * KELIĄ, o ne tekstą faile.
 */
test("gate savipatikra: failų lygio našlaičių patikra mato pilną našlaitį, barrel taikinį ir entrypoint", () => {
  const synthetic: Pick<ScannedFile, "relative" | "isTest" | "imports">[] = [
    // (1) pilnas našlaitis su bendravardžiu kanoniniame faile — TEN pat esantis skirtingas kelias.
    { relative: "infrastructure/persistence/orphan-store.ts", isTest: false, imports: new Set() },
    {
      relative: "application/code-intelligence/store/orphan-store.ts",
      isTest: false,
      imports: new Set(),
    },
    {
      relative: "composition/wiring.ts",
      isTest: false,
      imports: new Set(["application/code-intelligence/store/orphan-store.ts"]),
    },
    // (2) barrel taikinys — importuojamas TIK per `export * from`, ne tiesiogiai.
    { relative: "domain/leaf.ts", isTest: false, imports: new Set() },
    { relative: "domain/index.ts", isTest: false, imports: new Set(["domain/leaf.ts"]) },
    { relative: "composition/uses-barrel.ts", isTest: false, imports: new Set(["domain/index.ts"]) },
    // (3) entrypoint — niekas jo neimportuoja, bet KNOWN_ENTRYPOINTS jį pateisina.
    { relative: "cli.ts", isTest: false, imports: new Set() },
    // (4) testų failai nelaikomi našlaičių kandidatais.
    { relative: "tests/some.test.ts", isTest: true, imports: new Set() },
  ];

  const orphans = findOrphanFiles(synthetic, new Set(Object.keys(KNOWN_ENTRYPOINTS)));

  assert.ok(
    orphans.includes("infrastructure/persistence/orphan-store.ts"),
    "pilnas našlaitis su bendravardžiu kanoniniame faile turi būti pažeidimas",
  );
  assert.ok(
    !orphans.includes("application/code-intelligence/store/orphan-store.ts"),
    "kanoninis failas su importuotoju NĖRA našlaitis",
  );
  assert.ok(!orphans.includes("domain/leaf.ts"), "barrel'io taikinys NĖRA našlaitis");
  assert.ok(!orphans.includes("cli.ts"), "entrypoint NĖRA našlaitis");
  assert.ok(!orphans.includes("tests/some.test.ts"), "testų failai nelaikomi kandidatais");
});

test("gate: kiekvienas produkcinis failas turi importuotoją arba yra entrypoint", () => {
  const entrypoints = new Set(Object.keys(KNOWN_ENTRYPOINTS));
  const orphans = findOrphanFiles(files, entrypoints);

  const known = Object.keys(KNOWN_ORPHAN_FILES);
  const appeared = orphans.filter((entry) => !known.includes(entry)).sort();
  const disappeared = known.filter((entry) => !orphans.includes(entry)).sort();

  assert.deepEqual(
    appeared,
    [],
    "naujas našlaitis src failas: joks kitas failas jo kelio neimportuoja per specifikatorių. Ištrink " +
      "failą arba įrašyk į KNOWN_ORPHAN_FILES/KNOWN_ENTRYPOINTS su priežastimi — tylus praleidimas draudžiamas",
  );
  assert.deepEqual(
    disappeared,
    [],
    "šie KNOWN_ORPHAN_FILES įrašai nebeteisingi: failas prijungtas arba ištrintas. Išbrauk eilutę — " +
      "pasenęs pateisinimas dengia kitą tokį patį radinį",
  );
});
