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
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const SRC_ROOT = path.resolve(process.cwd(), "src");

/**
 * Ženklai, po kurių `/` pradeda REGEX literalą, o ne dalybą.
 *
 * Klasikinė JS leksavimo dviprasmybė. Heuristika ta pati, kurią naudoja minifikatoriai: po
 * operatoriaus, skliausto ar kablelio gali eiti tik reikšmė, tad `/` yra literalo pradžia; po
 * identifikatoriaus, skaičiaus ar `)` — dalyba.
 */
const REGEX_ALLOWED_AFTER = new Set("(,=:[!&|?{};+-*%~^<>".split(""));
const REGEX_ALLOWED_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * Komentarų šalinimas BŪSENOS mašina, o ne regexu.
 *
 * `body.replace(/\/\*[\s\S]*?\*\//g, "")` nežino, kad `/*` gali stovėti eilutės komentare arba
 * eilutėje, ir tada praryja kodą iki artimiausio uždarymo. Būsenos mašina to negali padaryti:
 * komentaro pradžia atpažįstama TIK iš kodo būsenos. Eilučių lūžiai išlaikomi, kad `^export`
 * inkarai ir eilučių numeriai liktų teisingi.
 *
 * REGEX literalai sekami atskirai (2026-08-24, antras tos pačios klasės radinys). Be jų
 * `.replace(/^`+|`+$/g, "")` pirmą backtick'ą paverčia template eilutės pradžia ir praryja kodą
 * iki kito backtick'o kitoje funkcijoje — `domain/tasks/size.ts` taip prarado kvietimą į
 * `matchProfileSourceRoot`. Kryptis PAVOJINGA: prarytas gabalas slepia KVIETĖJĄ, tad gyvas
 * eksportas paskelbiamas mirusiu. Simbolių klasė (`[^/*]`) irgi sekama — kitaip jos viduje
 * esantis `/` uždarytų literalą per anksti, o `/*` atidarytų fantominį bloką.
 */
function stripComments(source: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" | "regex" = "code";
  let inCharClass = false;
  let i = 0;

  /** Paskutinis reikšmingas jau išvestas ženklas — pagal jį sprendžiama regex vs dalyba. */
  const startsRegex = (): boolean => {
    const trimmed = out.replace(/\s+$/, "");
    if (trimmed === "") return true;
    const last = trimmed[trimmed.length - 1] ?? "";
    if (REGEX_ALLOWED_AFTER.has(last)) return true;
    const word = /([A-Za-z_$][\w$]*)$/.exec(trimmed);
    return word !== null && REGEX_ALLOWED_KEYWORDS.has(word[1] ?? "");
  };

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === "/" && startsRegex()) {
        state = "regex";
        inCharClass = false;
        out += c;
        i += 1;
        continue;
      }
      if (c === "'") state = "sq";
      else if (c === '"') state = "dq";
      else if (c === "`") state = "tpl";
      out += c;
      i += 1;
      continue;
    }

    if (state === "regex") {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === "[") inCharClass = true;
      else if (c === "]") inCharClass = false;
      else if (c === "/" && !inCharClass) state = "code";
      else if (c === "\n") state = "code"; // neužsidaręs literalas negali ryti kitų eilučių
      out += c;
      i += 1;
      continue;
    }

    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i += 1;
      continue;
    }

    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      if (c === "\n") out += c;
      i += 1;
      continue;
    }

    // Eilutės viduje: `\` praryja kitą simbolį, kad `"\""` nenutrūktų per anksti.
    if (c === "\\") {
      out += c + (next ?? "");
      i += 2;
      continue;
    }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) state = "code";
    out += c;
    i += 1;
  }

  return out;
}

/**
 * Re-eksporto eilutės (`export { x } from "./y.js"`) NELAIKOMOS kvietimu: barelis vardija
 * simbolį nieko su juo nedarydamas. Be šios išimties kiekvienas `index.ts` prikeltų visą po
 * savimi gulintį mirusį paviršių.
 */
function withoutReExports(strippedBody: string): string {
  return strippedBody
    .split("\n")
    .filter((line) => !/^\s*export\s+.*\bfrom\s+["']/.test(line))
    .join("\n");
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** Identifikatorius → kiek kartų failo tekste. Vienas praėjimas per failą vietoj regex per simbolį. */
function tokenCounts(body: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of body.matchAll(IDENTIFIER)) {
    const token = match[0];
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * Vartas tikrina REIKŠMES (`function`, `const`, `class`), o ne tipus — sąmoningai.
 *
 * 2026-08-24 pjūvis rado 9 nenaudojamus tipus, ir beveik visi buvo `z.infer<typeof xSchema>` arba
 * `(typeof xConst)[number]` šalia NAUDOJAMOS reikšmės. Tai modulio konvencija („zod prie
 * modulio"), o ne šiukšlė: schemos ir jos tipo pora rašoma kartu, ir tipas dažnai prireikia
 * pirmam kvietėjui, kuris ateis. Įtraukus tipus vartas baustų už teisingą idiomą ir stumtų
 * neeksportuoti tipo — t. y. gadintų kodą, kad praeitų patikra. Tipai runtime nekainuoja nieko.
 *
 * Tikras tipų perteklius (grynas pervadinimas, forma, kurią pakeitė kita) randamas auditu ir
 * trinamas rankomis — 2026-08-24 taip ištrinti `CodexProcessRunner`, `ResumeActor` ir
 * `ResolvedActiveAttempt`.
 */
const EXPORTED_FUNCTION = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
const EXPORTED_BINDING = /^export\s+(?:const|class)\s+([A-Za-z_$][\w$]*)/gm;

type ScannedFile = {
  relative: string;
  isTest: boolean;
  counts: Map<string, number>;
  exported: string[];
};

async function collect(dir: string, prefix: string, out: ScannedFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collect(path.join(dir, entry.name), relative, out);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const stripped = stripComments(await readFile(path.join(dir, entry.name), "utf8"));
    const isTest = relative.startsWith("tests/");
    const body = isTest ? stripped : withoutReExports(stripped);
    const exported = isTest
      ? []
      : [...body.matchAll(EXPORTED_FUNCTION), ...body.matchAll(EXPORTED_BINDING)]
          .map((match) => match[1])
          .filter((name): name is string => name !== undefined);
    out.push({ relative, isTest, counts: tokenCounts(body), exported: [...new Set(exported)] });
  }
}

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
  "application/context-pack/arrest-attribution.ts#selectArrestCountableHumanReviewTaskIds": "FORWARD",
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
