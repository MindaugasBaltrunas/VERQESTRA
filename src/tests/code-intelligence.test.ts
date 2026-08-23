// VQ-301: code-intelligence klasterio unit testai — mermaid parser, stack signal
// ekstrakcija, retrieval ranking/fragmentai, code-map generavimas/aprėptis, guard taisyklė.
// Fixture'inis parity gyvena characterization-code-index.test.ts.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isMermaidFlowchart, parseMermaidFlowchart } from "../application/code-intelligence/graph-source/mermaid-parser.js";
import { extractStackSignals } from "../application/code-intelligence/graph-source/stack-signal-extraction.js";
import { fromGraphSource } from "../domain/architecture/graph-import.js";
import { rankRetrievalCandidates } from "../application/code-intelligence/retrieval/ranking.js";
import { chunkMarkdownByHeading } from "../application/code-intelligence/retrieval/markdown-chunks.js";
import {
  applySpecFragmentBudget,
  clipToBoundary,
  retrieveSpecFragmentCandidates,
} from "../application/code-intelligence/retrieval/spec-fragments.js";
import type { CodeIntelligenceFileSystemPort } from "../application/code-intelligence/ports.js";
import {
  extractImportEdges,
  extractSymbolRecords,
  layerForSourcePath,
} from "../application/code-intelligence/code-map/ast-symbol-scanner.js";
import {
  classIdForFile,
  generateCodeMapMermaid,
  resolveImportTarget,
} from "../application/code-intelligence/code-map/generator.js";
import { computeCodeMapCoverage } from "../application/code-intelligence/code-map/coverage.js";
import { requiresFreshCodeIndex } from "../application/code-intelligence/query/guard.js";
import { nodeFsTestPort } from "./helpers/node-fs-port.js";

test("mermaid parser: node shapes, edge labels, directive gate", () => {
  assert.ok(isMermaidFlowchart("%% komentaras\nflowchart TD\nA-->B"));
  assert.ok(!isMermaidFlowchart("classDiagram\nclass X"));
  assert.throws(() => parseMermaidFlowchart("classDiagram"), /expected "flowchart" or "graph" directive/);

  const graph = parseMermaidFlowchart(
    ["graph LR", "A[Git Repository] --> B(Scanner)", "B -->|feeds| C{Gate}", "C -- verdict --> D", "E((Lone))"].join("\n"),
  );
  assert.deepEqual(
    graph.nodes.map((node) => `${node.id}:${node.label}`),
    ["A:Git Repository", "B:Scanner", "C:Gate", "D:D", "E:Lone"],
  );
  assert.deepEqual(graph.edges, [
    { from: "A", to: "B" },
    { from: "B", to: "C", label: "feeds" },
    { from: "C", to: "D", label: "verdict" },
  ]);
});

test("mermaid output feeds domain fromGraphSource structurally (E2 inversija)", () => {
  const parsed = parseMermaidFlowchart("graph TD\nA[Git Repository] --> B[Worker Service]");
  const architecture = fromGraphSource(parsed, "doc/a.mmd", "2026-08-19T00:00:00.000Z");
  assert.equal(architecture.nodes.find((node) => node.id === "A")?.external, true);
});

test("stack signal extraction: categories, app type, hints, unmodeled-node risk", () => {
  const graph = fromGraphSource(
    parseMermaidFlowchart(
      ["graph TD", "UI[Web Frontend] --> API[REST Controller]", "API --> DB[(ignored)]", "DB2[Postgres Store]"].join("\n"),
    ),
    "doc/a.mmd",
    "t",
  );
  const signals = extractStackSignals(graph, [
    { node_id: "API", source: "readme", excerpt: "Docker deploy su auth token", timestamp: "t" },
  ]);
  assert.equal(signals.appType, "fullstack");
  assert.ok(signals.uiNodeIds.includes("UI"));
  assert.ok(signals.apiNodeIds.includes("API"));
  assert.ok(signals.dataNodeIds.includes("DB2"));
  assert.ok(signals.deploymentHints.includes("deployment:docker"));
  assert.ok(signals.riskHints.includes("risk:auth"));
  assert.ok(signals.riskHints.includes("risk:secrets"));
  assert.ok(signals.riskHints.includes("risk:unmodeled-node"), "unknown kind mazgai kelia riziką");
  assert.equal(signals.complexity.level, "low");
});

test("markdown chunks: preface root, heading sections, empty chunks dropped", () => {
  const chunks = chunkMarkdownByHeading(["prieš antraštę", "", "# Pirma", "turinys", "## Antra", "kitas"].join("\n"));
  assert.deepEqual(
    chunks.map((chunk) => `${chunk.level}:${chunk.heading}`),
    ["0:<root>", "1:Pirma", "2:Antra"],
  );
});

// Fenced code bloke `# eilutė` NĖRA antraštė (2026-08-23 auditas): etalono elgsena bash
// `# komentarą` versdavo fantomine 1 lygio antrašte, kuri tyliai nukirsdavo prašytą sekciją
// ir galėjo klaidingai atitikti prašytą antraštę.
test("markdown chunks: fenced code blokai nekuria fantominių antraščių", () => {
  const chunks = chunkMarkdownByHeading(
    [
      "## Diegimas",
      "```bash",
      "# įdiek priklausomybes",
      "pnpm install",
      "```",
      "po bloko",
      "~~~",
      "## ne antraštė tilde bloke",
      "~~~",
      "## Kita",
      "kitas tekstas",
    ].join("\n"),
  );
  assert.deepEqual(
    chunks.map((chunk) => `${chunk.level}:${chunk.heading}`),
    ["2:Diegimas", "2:Kita"],
  );
  assert.ok(chunks[0]?.text.includes("# įdiek priklausomybes"), "fence turinys lieka sekcijos viduje");
  assert.ok(chunks[0]?.text.includes("po bloko"), "sekcija tęsiasi po uždaryto fence");
  assert.ok(chunks[0]?.text.includes("## ne antraštė tilde bloke"), "tilde fence irgi dengia");
});

test("spec fragments: heading match, heading miss, change-dir expansion, char budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-301-frag-"));
  try {
    await writeFile(path.join(root, "spec.md"), "# Alfa\nalfa tekstas\n# Beta\nbeta tekstas\n", "utf8");
    await mkdir(path.join(root, "change"), { recursive: true });
    await writeFile(path.join(root, "change", "proposal.md"), "change proposal turinys", "utf8");

    const { fragments, unresolved } = await retrieveSpecFragmentCandidates(
      nodeFsTestPort,
      root,
      ["spec.md#beta", "spec.md#nerasta", "change", "nėra.md"],
      1000,
    );
    assert.equal(fragments.length, 3);
    assert.equal(fragments[0]?.text, "# Beta\nbeta tekstas");
    assert.equal(fragments[0]?.headingMiss, undefined);
    assert.equal(fragments[1]?.headingMiss, "nerasta", "nerasta antraštė deklaruojama, ne nutylima");
    assert.equal(fragments[2]?.text, "change proposal turinys", "katalogas išskleidžiamas į proposal.md");
    assert.deepEqual(
      unresolved,
      [{ ref: "nėra.md", reason: "not_found" }],
      "nerastas ref'as deklaruojamas, o ne dingsta tyliai",
    );

    const clipped = await retrieveSpecFragmentCandidates(nodeFsTestPort, root, ["spec.md"], 5);
    assert.ok((clipped.fragments[0]?.text.length ?? 99) <= 5, "per-fragmento lubos kerpa tekstą");
    assert.equal(clipped.fragments[0]?.truncated, true, "kirpimas pažymimas jau pirmoje fazėje");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Antraštės sekcija privalo ateiti su savo poskyriais. Plokščias chunker'is nutraukdavo ją
// ties BET KURIA kita antrašte, tad `## API` atkeliaudavo be `### Request` ir `### Response` —
// t. y. be to, ko task'as ir prašė. Ir tai atrodydavo kaip sėkmė: headingMiss netaikomas, tad
// apie nukirstą turinį niekas nepranešdavo.
test("spec fragments: antraštės sekcija apima gilesnius poskyrius, baigiasi ties lygiu (auditas)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-rag-heading-"));
  try {
    await writeFile(
      path.join(root, "spec.md"),
      [
        "# Dokumentas",
        "įžanga",
        "## API",
        "api įžanga",
        "### Request",
        "request laukai",
        "#### Headers",
        "headers detalės",
        "### Response",
        "response laukai",
        "## Kita sekcija",
        "šito NETURI būti",
        "",
      ].join("\n"),
      "utf8",
    );

    const { fragments } = await retrieveSpecFragmentCandidates(nodeFsTestPort, root, ["spec.md#api"], 10_000);
    const text = fragments[0]?.text ?? "";

    assert.ok(text.startsWith("## API"), "sekcija prasideda prašyta antrašte");
    for (const nested of ["### Request", "request laukai", "#### Headers", "headers detalės", "### Response"]) {
      assert.ok(text.includes(nested), `gilesnis poskyris privalo patekti: ${nested}`);
    }
    assert.ok(!text.includes("## Kita sekcija"), "to paties lygio antraštė sekciją baigia");
    assert.ok(!text.includes("šito NETURI būti"));
    assert.ok(!text.includes("# Dokumentas"), "aukštesnio lygio antraštė į sekciją nepatenka");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Ne-Markdown nuoroda su `#anchor`: antraštės ten apskritai neieškoma, tad grąžinamas VISAS
// failas. Anksčiau `headingMiss` irgi būdavo praleidžiamas, tad `toRetrievalCandidate` iš to
// darydavo `headingMatched: true` — ne-Markdown ref'as gaudavo `heading_match` pakopą, skirtą
// tiksliai rastai sekcijai, ir jokio įspėjimo. Sėkmės apsimetimas, ne šiaip netikslumas.
test("spec fragments: `config.json#foo` yra nepataikymas, ne heading_match (auditas)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-rag-nonmd-"));
  try {
    await writeFile(path.join(root, "config.json"), '{\n  "foo": 1,\n  "bar": 2\n}\n', "utf8");

    const { fragments } = await retrieveSpecFragmentCandidates(nodeFsTestPort, root, ["config.json#foo"], 10_000);
    assert.equal(fragments[0]?.headingMiss, "foo", "nepataikymas deklaruojamas, o ne nutylimas");
    assert.equal(fragments[0]?.headingUnsupported, true, "priežastis: antraštės čia iš viso neieškoma");
    assert.ok((fragments[0]?.text ?? "").includes('"bar"'), "grąžintas visas failas, ne sekcija");

    // Ir esminis pasekmės tvirtinimas: reitingavime tai nusileidžia TIKRAM antraštės atitikmeniui.
    const ranked = rankRetrievalCandidates(
      [
        { ref: "config.json#foo", text: fragments[0]?.text ?? "", requestedHeading: "foo", headingMatched: false },
        { ref: "doc/spec.md#alfa", text: "## Alfa\nsekcija", requestedHeading: "alfa", headingMatched: true },
      ],
      { query: "alfa foo" },
    );
    assert.deepEqual(
      ranked.map((entry) => entry.tier),
      ["heading_match", "general_docs"],
      "visas failas negali stovėti greta tiksliai rastos sekcijos",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Change KATALOGO nuoroda su antrašte: rūšis anksčiau buvo sprendžiama pagal ref'e parašytą
// kelią, kuris `.md` nesibaigia, tad `#Heading` būdavo tyliai ignoruojamas — būtent openspec
// nuorodoms, kurias šis projektas naudoja dažniausiai.
test("spec fragments: change-katalogo ref'as su antrašte ją randa išskleistame faile (auditas)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-rag-changedir-"));
  try {
    await mkdir(path.join(root, "changes", "vq-1"), { recursive: true });
    await writeFile(
      path.join(root, "changes", "vq-1", "proposal.md"),
      ["# Proposal", "bendra dalis", "## Tikslas", "tikslo tekstas", "## Rizikos", "rizikų tekstas", ""].join("\n"),
      "utf8",
    );

    const { fragments } = await retrieveSpecFragmentCandidates(
      nodeFsTestPort,
      root,
      ["changes/vq-1#tikslas"],
      10_000,
    );

    assert.equal(fragments[0]?.headingMiss, undefined, "antraštė RASTA, o ne tyliai ignoruota");
    assert.equal(fragments[0]?.text, "## Tikslas\ntikslo tekstas");
    assert.ok(!(fragments[0]?.text ?? "").includes("rizikų tekstas"), "kita to paties lygio sekcija neįtraukiama");

    // TRŪKSTAMA antraštė tame pačiame change kataloge: nepataikymas fiksuojamas, bet priežastis
    // NĖRA „ne Markdown" — galutinis failas yra proposal.md ir antraštės tikrai ieškota. Iš ref'o
    // išvedant, ši nuoroda gautų melagingą patarimą nuimti teisingą anchor'ą.
    const missing = await retrieveSpecFragmentCandidates(nodeFsTestPort, root, ["changes/vq-1#nerasta"], 10_000);
    assert.equal(missing.fragments[0]?.headingMiss, "nerasta");
    assert.equal(
      missing.fragments[0]?.headingUnsupported,
      undefined,
      "change katalogas išsiskleidžia į .md, tad anchor'as čia PALAIKOMAS",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Rūšis nustatoma per `statKind`, NE per tėvinio katalogo listinimą, ir „nežinia" yra
// fail-closed. Fake portas fiksuoja abu dalykus vienu metu: `listDirectory` visada tuščias
// (tad senas kelias duotų „ne katalogas" ir kristų į readTextFile), o vienas ref'as yra
// `absent` — neperskaitomas kelias, kurio skaitymas realiame fs mestų EISDIR ir nuverstų
// VISĄ context pack'ą. Turi būti praleistas tylėdamas, likę fragmentai — nepaliesti.
test("spec fragments: rūšis per statKind; nenustatyta rūšis praleidžiama, o ne verčia EISDIR", async () => {
  const root = path.resolve("/vq-frag-statkind");
  const norm = (value: string): string => value.replace(/\\/g, "/");
  const key = (...parts: string[]): string => norm(path.join(root, ...parts));

  const kinds = new Map<string, "file" | "directory" | "absent">([
    [key("spec.md"), "file"],
    [key("change"), "directory"],
    [key("change", "proposal.md"), "file"],
    [key("neperskaitomas"), "absent"],
  ]);
  const texts = new Map<string, string>([
    [key("spec.md"), "spec turinys"],
    [key("change", "proposal.md"), "proposal turinys"],
  ]);

  let listCalls = 0;
  const fs: CodeIntelligenceFileSystemPort = {
    listDirectory: async () => {
      listCalls += 1;
      return [];
    },
    statKind: async (p) => kinds.get(norm(p)) ?? "absent",
    readTextFile: async (p) => {
      const text = texts.get(norm(p));
      // Realus fs čia mestų EISDIR; testas tvirtina, kad iki šios eilutės neprieinama.
      if (text === undefined) throw new Error(`EISDIR: illegal operation on a directory, read ${norm(p)}`);
      return text;
    },
    readFileBytes: async () => new Uint8Array(),
    fileSize: async () => 0,
    exists: async (p) => kinds.has(norm(p)),
    writeTextFileAtomic: async () => {},
    makeDirectory: async () => {},
  };

  const { fragments, unresolved } = await retrieveSpecFragmentCandidates(
    fs,
    root,
    ["neperskaitomas", "change", "spec.md"],
    1000,
  );

  assert.deepEqual(
    fragments.map((fragment) => fragment.ref),
    ["change", "spec.md"],
    "`absent` (nėra ARBA rūšies nustatyti nepavyko) praleidžiamas, likę ref'ai išlieka",
  );
  assert.deepEqual(unresolved, [{ ref: "neperskaitomas", reason: "not_found" }]);
  assert.equal(fragments[0]?.text, "proposal turinys", "katalogas išskleistas nelistinant tėvo");
  assert.equal(listCalls, 0, "rūšis nebeeina per listDirectory — tėvinio katalogo skaitymo nebėra");
});

// Spec ref'as ateina iš task'o teksto, o jo turinys keliauja į LLM promptą ir į cache.
// Preflight paprastus pabėgimus atmeta, bet context-pack surinkimas kviečiamas ir tiesiogiai,
// tad retrieval privalo turėti SAVO fail-closed vartą. Nė vienas iš šių ref'ų neturi teisės
// nei būti perskaitytas, nei nutildytas — kiekvienas deklaruojamas kaip `outside_project`.
test("spec fragments: už projekto ribų vedantis ref'as atmetamas ir deklaruojamas", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-rag-escape-"));
  try {
    await writeFile(path.join(root, "vidus.md"), "vidinis turinys\n", "utf8");

    let readAttempts = 0;
    const watched: CodeIntelligenceFileSystemPort = {
      ...nodeFsTestPort,
      readTextFile: async (p) => {
        readAttempts += 1;
        return await nodeFsTestPort.readTextFile(p);
      },
    };

    // Tik platformai stabilūs atvejai: `"C:/…"` Linux'e nėra absoliutus, tad jis ten kristų
    // į `not_found`, o ne į `outside_project` — vartas veiktų, bet testas meluotų apie kelią.
    const escaping = ["../slaptas.md", "../../etc/passwd", path.join(root, "..", "gretimas.md")];
    const { fragments, unresolved } = await retrieveSpecFragmentCandidates(
      watched,
      root,
      [...escaping, "vidus.md"],
      1000,
    );

    assert.deepEqual(fragments.map((entry) => entry.ref), ["vidus.md"], "praeina TIK projekto vidus");
    assert.deepEqual(
      unresolved,
      escaping.map((ref) => ({ ref, reason: "outside_project" })),
      "kiekvienas pabėgimas deklaruojamas, ne nutylimas",
    );
    assert.equal(readAttempts, 1, "už ribų esantis kelias net neskaitomas");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A1 regresijos tinklas. Task'o surašymo tvarka ir reitingavimo tvarka čia SĄMONINGAI
// priešingos: pirmas sąraše yra antraštės atitikmuo (pakopa 2), antras — viso dokumento
// nuoroda (pakopa 1). Biudžeto užtenka tik vienam. Iki taisymo laimėdavo tas, kurį autorius
// atsitiktinai parašė pirmas; dabar privalo laimėti aukštesnė pakopa.
test("spec fragments: biudžetą leidžia REITINGAS, ne task'o surašymo eilė (A1)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-rag-a1-"));
  try {
    await writeFile(path.join(root, "notes.md"), "# Alfa\nalfa smulkmena\n", "utf8");
    await writeFile(path.join(root, "spec.md"), "visas spec dokumentas\n", "utf8");

    const refs = ["notes.md#alfa", "spec.md"];
    const budgetChars = 21; // telpa lygiai „visas spec dokumentas"

    const candidates = await retrieveSpecFragmentCandidates(nodeFsTestPort, root, refs, budgetChars);
    assert.equal(candidates.fragments.length, 2, "abu ref'ai PAIMAMI — biudžetas dar nedalijamas");

    const ranked = rankRetrievalCandidates(
      candidates.fragments.map((fragment) => ({
        ref: fragment.ref,
        text: fragment.text,
        ...(fragment.ref.includes("#")
          ? { requestedHeading: fragment.ref.split("#")[1] ?? "", headingMatched: fragment.headingMiss === undefined }
          : {}),
      })),
      { query: "spec dokumentas" },
    );
    const ordered = ranked
      .map((entry) => candidates.fragments[entry.index])
      .filter((fragment): fragment is NonNullable<typeof fragment> => fragment !== undefined);
    assert.deepEqual(ordered.map((fragment) => fragment.ref), ["spec.md", "notes.md#alfa"]);

    const selection = applySpecFragmentBudget(ordered, 8, budgetChars);
    assert.deepEqual(
      selection.kept.map((fragment) => fragment.ref),
      ["spec.md"],
      "biudžetą gauna aukščiausia pakopa, nors task'e ji surašyta antra",
    );
    assert.deepEqual(selection.dropped, [{ ref: "notes.md#alfa", reason: "char_budget" }]);
    assert.deepEqual(selection.truncated, [], "tilpęs fragmentas nekarpomas");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Fragmentų limitas taip pat privalo veikti reitinguota tvarka, o kiekvienas iškritęs ar
// apkarpytas ref'as — būti deklaruotas (A4): tylus praradimas buvo pusė A1 žalos.
test("spec fragments: limitas ir apkarpymas deklaruojami, ne nutylimi (A4)", () => {
  const fragment = (ref: string, text: string): { ref: string; text: string } => ({ ref, text });

  const limited = applySpecFragmentBudget([fragment("a.md", "aaa"), fragment("b.md", "bbb")], 1, 1000);
  assert.deepEqual(limited.kept.map((entry) => entry.ref), ["a.md"]);
  assert.deepEqual(limited.dropped, [{ ref: "b.md", reason: "fragment_limit" }]);

  const clipped = applySpecFragmentBudget([fragment("a.md", "aaaaa")], 8, 3);
  assert.equal(clipped.kept[0]?.text, "aaa", "netelpantis fragmentas kerpamas iki likučio");
  assert.equal(clipped.kept[0]?.truncated, true, "žyma keliauja SU fragmentu, ne tik sąraše");
  assert.deepEqual(clipped.truncated, ["a.md"], "apkarpymas deklaruojamas");
  assert.deepEqual(clipped.dropped, []);

  // Kirpimas pirmoje fazėje (per-fragmento lubos) antroje fazėje nebepasikartoja, tad be
  // atsineštos žymos jis liktų nepastebėtas — fragmentas atkeliautų nepilnas ir be ženklo.
  const alreadyCut = applySpecFragmentBudget([{ ref: "a.md", text: "aaa", truncated: true }], 8, 1000);
  assert.deepEqual(alreadyCut.truncated, ["a.md"], "ankstesnės fazės kirpimas neprarandamas");
  assert.equal(alreadyCut.kept[0]?.truncated, true);

  // Dublikatas anksčiau suvalgydavo biudžetą DUKART, o vis tiek iškrisdavo vėlesniame
  // dedupeStable — biudžetas prarastas be jokios naudos.
  const duplicated = applySpecFragmentBudget(
    [fragment("a.md", "aaa"), fragment("a.md", "aaa"), fragment("b.md", "bbb")],
    8,
    6,
  );
  assert.deepEqual(duplicated.kept.map((entry) => entry.ref), ["a.md", "b.md"], "dublikatas biudžeto nebekainuoja");
  assert.deepEqual(duplicated.dropped, [{ ref: "a.md", reason: "duplicate" }]);
  assert.deepEqual(duplicated.truncated, [], "b.md telpa, nes dublikatas biudžeto nesuvalgė");
});

// Aklas `slice` nutraukia sakinio viduryje, ir toks fragmentas skaitomas kaip pilnas, tik
// nelogiškas. Pastraipos riba palieka bent savaime nuoseklų tekstą — bet tik tada, kai dėl jos
// neaukojama per daug biudžeto.
test("spec fragments: kirpimas ties pastraipos riba, su atsarga aklam pjūviui", () => {
  const text = "pirma pastraipa\n\nantra pastraipa\n\ntrečia pastraipa";

  assert.equal(clipToBoundary(text, text.length), text, "telpantis tekstas nekerpamas");
  assert.equal(
    clipToBoundary(text, 40),
    "pirma pastraipa\n\nantra pastraipa",
    "kerpama ties paskutine TELPANČIA pastraipos riba, be pakabinto tuščio tarpo",
  );
  assert.equal(clipToBoundary(text, 20), "pirma pastraipa", "riba randama ir tada, kai lange telpa tik ji");

  // Riba per anksti: laikytis jos reikštų atiduoti didžiąją dalį biudžeto, tad pjaunama aklai.
  assert.equal(clipToBoundary(`a\n${"b".repeat(100)}`, 50).length, 50, "per brangi riba atmetama");
  assert.equal(clipToBoundary("bet koks", 0), "", "nulinis biudžetas duoda tuščią tekstą");
});

test("code-map: scanner records, mermaid render and coverage close the loop", () => {
  const source = [
    'import { helper } from "./helper.js";',
    "export class Engine {",
    "  run(): string { return helper(); }",
    "}",
    "export const VERSION = 1;",
  ].join("\n");
  const symbols = extractSymbolRecords("src/application/engine.ts", source, "application");
  assert.deepEqual(
    symbols.map((record) => `${record.kind}:${record.name}`),
    ["class:Engine", "method:Engine.run", "const:VERSION"],
  );
  const helperSymbols = extractSymbolRecords("src/application/helper.ts", "export function helper(): string { return \"x\"; }", "application");
  const imports = extractImportEdges("src/application/engine.ts", source, "application");
  assert.deepEqual(imports, [{ fromFile: "src/application/engine.ts", fromLayer: "application", toModule: "./helper.js" }]);

  const mermaid = generateCodeMapMermaid([...symbols, ...helperSymbols], imports);
  assert.match(mermaid, /class src_application_engine\["src\/application\/engine.ts"\]/);
  assert.match(mermaid, /src_application_engine --> src_application_helper/);
  const coverage = computeCodeMapCoverage([...symbols, ...helperSymbols], mermaid);
  assert.equal(coverage.coverage_percent, 100);
  assert.deepEqual(coverage.missing_symbols, []);

  assert.equal(classIdForFile("src/a-b.ts"), "src_a_b");
  assert.equal(resolveImportTarget("src/a.ts", "./b.js", new Set(["src/b.ts"])), "src/b.ts");
  assert.equal(resolveImportTarget("src/a.ts", "zod", new Set(["src/b.ts"])), null);
  assert.equal(layerForSourcePath("src/application/engine.ts", { relativeDir: "src" }), "application");
  assert.equal(layerForSourcePath("src/cli.ts", { relativeDir: "src" }), "root");
  assert.equal(layerForSourcePath("ui/src/x.ts", { relativeDir: "ui/src", fixedLayer: "ui-app" }), "ui-app");
});

test("guard rule: graph-aware task requires fresh index unless it builds one itself", () => {
  assert.ok(requiresFreshCodeIndex("Naudok code graph context analizei."));
  assert.ok(!requiresFreshCodeIndex("Paleisk code-index build ir tada code graph context."));
  assert.ok(!requiresFreshCodeIndex("Paprastas taskas be grafo."));
});
