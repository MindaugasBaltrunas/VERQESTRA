// VQ-003f recorder: uzfiksuoja ETALONO (`AG_loop`) `assembleContextPack` elgsena pries
// scenariju workspace'us ir perraso
// `src/tests/fixtures/characterization/context-pack-assembly.json` `etalon` blokus.
//
// Grieztos sio irankio ribos:
//  1. AG_loop NERASOMAS — importuojamas tik jo `dist`, rasoma tik i tmpdir.
//  2. Irankis NESKAITO VERQESTRA elgsenos. `deviations` (rankomis surasytas nukrypimu
//     registras) paimamas is ESAMO fixture failo ir perkeliamas nepakeistas. Nera jokio
//     kelio, kuriuo VERQESTRA rezultatas galetu tyliai tapti „lukesciu" (PAR-1).
//
// Paleidimas: node scripts/record-context-pack-assembly.mjs [--orchestrator <kelias>]

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
const orchIndex = argv.indexOf("--orchestrator");
const ORCHESTRATOR = orchIndex >= 0 ? argv[orchIndex + 1] : "D:/React/AG_loop/AG/orchestrator";
const FIXTURE = path.join(process.cwd(), "src", "tests", "fixtures", "characterization", "context-pack-assembly.json");
const ETALON_RUNTIME = "AG";

const SPEC_MD = [
  "# Alfa",
  "",
  "Alfa sekcijos tekstas: modulio kontraktas.",
  "",
  "# Beta",
  "",
  "Beta sekcijos tekstas: nesusijes su moduliu.",
  "",
].join(NL);

const NESTED_MD = [
  "# Modulio API",
  "",
  "Ivadas.",
  "",
  "## API",
  "",
  "Bendras API aprasas.",
  "",
  "### Request",
  "",
  "Uzklausos laukai: id, mode.",
  "",
  "### Response",
  "",
  "Atsakymo laukai: ok, reason.",
  "",
  "# Kita",
  "",
  "Kita sekcija.",
  "",
].join(NL);

const LARGE_MD = [
  "# Gama",
  "",
  ...Array.from(
    { length: 12 },
    (_, i) => `Gamos pastraipa ${i + 1}: ilgas aprasas, kuris sunaudoja biudzeta ir verstu budgeteri rinktis.`,
  ),
  "",
  "# Delta",
  "",
  "Delta sekcija: trumpa.",
  "",
].join(NL);

const task = ({ specSources = [], goal, files, checks = ["pnpm test"], agents = "readme-guard -> coder -> tester" }) =>
  [
    "# Task",
    "",
    ...(specSources.length > 0 ? ["## Spec source", ...specSources, ""] : []),
    "## Tikslas",
    goal,
    "",
    "## Agentai",
    agents,
    "",
    "## Failai",
    "Leidziama:",
    ...files.map((file) => "- `" + file + "`"),
    "Draudziama:",
    "- `.env*`",
    "",
    "## Veiksmas",
    "- Pakeisti eksporta.",
    "- Padengti testu.",
    "",
    "## Patikra",
    ...checks.map((check) => "- `" + check + "`"),
    "",
    "## Stop",
    "Kai patikros zalios, sustok.",
    "",
  ].join(NL);

const src = (lines) => lines.join(NL);

const BASE_FILES = {
  "doc/spec.md": SPEC_MD,
  "doc/nested.md": NESTED_MD,
  "doc/large.md": LARGE_MD,
  "src/module/a.ts": src([
    "export interface DemoInput {",
    "  id: string;",
    "}",
    "",
    "export function demo(input: DemoInput): string {",
    "  return input.id;",
    "}",
    "",
  ]),
  "src/module/b.ts": src([
    'import { demo } from "./a.js";',
    "",
    "export function callDemo(): string {",
    '  return demo({ id: "x" });',
    "}",
    "",
  ]),
  "src/tests/module-a.test.ts": src([
    'import { demo } from "../module/a.js";',
    "",
    'export const checked = demo({ id: "t" }).length > 0;',
    "",
  ]),
};

const CASES = [
  {
    id: "baseline",
    description:
      "Kanoninis kelias: du spec ref'ai (plokščia sekcija + įdėtos posekcijos), vienas leidžiamas failas, iš anksto pastatytas code index. Pack'as, jo raktų tvarka, artefaktų keliai ir telemetrija.",
    files: {
      "AG/tasks/queue/0042-demo.md": task({
        specSources: ["doc/spec.md#alfa", "doc/nested.md#API"],
        goal: "Igyvendinti demo modulio pakeitima.",
        files: ["src/module/a.ts"],
      }),
    },
    args: ["AG/tasks/queue/0042-demo.md"],
    prebuild_index: true,
    runs: 1,
  },
  {
    id: "heading-miss",
    description:
      "Prašyta antraštė dokumente neegzistuoja: fragmentas pack'e YRA, bet kaip visas dokumentas, ir kartu keliauja `spec heading not found:` įspėjimas.",
    files: {
      "AG/tasks/queue/0043-miss.md": task({
        specSources: ["doc/spec.md#nera-tokios"],
        goal: "Nepataikyta antraste.",
        files: ["src/module/a.ts"],
      }),
    },
    args: ["AG/tasks/queue/0043-miss.md"],
    prebuild_index: true,
    runs: 1,
  },
  {
    id: "budget-shrink",
    description:
      "Ankštas `max_context_chars`: vienas prioritetinis biudžeto sprendimas numeta žemiausio prioriteto šaltinius (code-graph kaimynai, impacted tests) ir palieka spec ref'us; pack'as telpa į ribą.",
    files: {
      "{runtime}/config/context-budget.json": src([
        "{",
        '  "max_context_chars": 3650,',
        '  "max_spec_fragments": 8,',
        '  "max_file_fragments": 8,',
        '  "max_files": 8',
        "}",
        "",
      ]),
      "AG/tasks/queue/0044-shrink.md": task({
        specSources: ["doc/spec.md#alfa", "doc/large.md#gama", "doc/spec.md#beta"],
        goal: "Ankstas biudzetas: budgeteris privalo rinktis.",
        files: ["src/module/a.ts", "src/module/b.ts"],
      }),
    },
    args: ["AG/tasks/queue/0044-shrink.md"],
    prebuild_index: true,
    runs: 1,
  },
  {
    id: "code-graph",
    description:
      "`--with-code-graph` be spec šaltinių: eksplicitinis grafo pjūvis — related files, impacted tests, priority order, simbolių fragmentai.",
    files: {
      "AG/tasks/queue/0045-graph.md": task({
        goal: "Grafo pjuvis be spec saltiniu.",
        files: ["src/module/a.ts"],
      }),
    },
    args: ["AG/tasks/queue/0045-graph.md", "--with-code-graph"],
    prebuild_index: true,
    runs: 1,
  },
  {
    id: "cache-hit",
    description:
      "Du surinkimai nepakitusioje darbo kopijoje: pirmas `miss`, antras `hit`, pack'as byte-identiškas (kešo idempotencija).",
    files: {
      "AG/tasks/queue/0046-cache.md": task({
        specSources: ["doc/spec.md#alfa"],
        goal: "Keso idempotencija.",
        files: ["src/module/a.ts"],
      }),
    },
    args: ["AG/tasks/queue/0046-cache.md"],
    prebuild_index: true,
    runs: 2,
  },
];

const METRIC_KEYS = [
  "task_id",
  "cache_status",
  "dropped_item_count",
  "spec_dropped_count",
  "code_context_dropped_count",
  "code_context_rebuilt",
];

const toPosix = (value) => value.split(path.sep).join("/");

const neutralize = (value) => {
  if (typeof value === "string") return value.replaceAll(ETALON_RUNTIME + "/", "{runtime}/");
  if (Array.isArray(value)) return value.map(neutralize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, neutralize(item)]));
  }
  return value;
};

const importEtalon = async (relative) => import(pathToFileURL(path.join(ORCHESTRATOR, "dist", relative)).href);

async function projectRun(root, result) {
  const encoded = await readFile(result.outputPath, "utf8");
  const metricsRaw = await readFile(path.join(root, ETALON_RUNTIME, "logs", "context-size.jsonl"), "utf8").catch(
    () => "",
  );
  const lines = metricsRaw.trim().split(NL).filter(Boolean);
  const record = lines.length > 0 ? JSON.parse(lines.at(-1)) : {};
  const metrics = {};
  for (const key of METRIC_KEYS) if (key in record) metrics[key] = record[key];
  return {
    output_path: neutralize(toPosix(path.relative(root, result.outputPath))),
    execution_context_path: neutralize(toPosix(path.relative(root, result.executionContextPath))),
    pack_chars: encoded.length,
    pack_key_order: Object.keys(JSON.parse(encoded)),
    pack: neutralize(JSON.parse(encoded)),
    metrics: neutralize(metrics),
  };
}

const { assembleContextPack } = await importEtalon("application/context-pack/assemble.js");
const { buildCodeIndex } = await importEtalon("code-index/builder.js");

// Nukrypimu registras yra RANKINIS turinys: recorder ji perkelia, o ne perskaiciuoja.
const previous = existsSync(FIXTURE) ? JSON.parse(await readFile(FIXTURE, "utf8")) : { cases: [] };
const previousDeviations = new Map(previous.cases.map((entry) => [entry.id, entry.deviations]));

const cases = [];
for (const spec of CASES) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-003f-" + spec.id + "-"));
  try {
    for (const [relative, body] of Object.entries({ ...BASE_FILES, ...spec.files })) {
      const target = path.join(root, relative.replaceAll("{runtime}", ETALON_RUNTIME));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body, "utf8");
    }
    if (spec.prebuild_index) await buildCodeIndex(root);
    const runs = [];
    for (let index = 0; index < spec.runs; index += 1) {
      runs.push(await projectRun(root, await assembleContextPack(spec.args, root)));
    }
    const deviations = previousDeviations.get(spec.id);
    if (deviations === undefined) {
      throw new Error(
        spec.id +
          ": fixture neturi `deviations` irašo. Nukrypimu registras rašomas RANKOMIS ir pagrindžiamas; recorder jo nesugalvoja.",
      );
    }
    cases.push({
      id: spec.id,
      description: spec.description,
      args: spec.args,
      prebuild_index: spec.prebuild_index,
      files: spec.files,
      etalon: runs,
      deviations,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const fixture = {
  schema_version: 1,
  record: false,
  description: previous.description,
  provenance: previous.provenance,
  deviation_catalog: previous.deviation_catalog,
  workspace: { files: BASE_FILES },
  cases,
};

await writeFile(FIXTURE, JSON.stringify(fixture, null, 2) + NL, "utf8");
console.log("etalon irasytas: " + cases.length + " atvejai, " + cases.reduce((sum, c) => sum + c.etalon.length, 0) + " paleidimai");
