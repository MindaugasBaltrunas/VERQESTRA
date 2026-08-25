// Task 006: neįvardytų kandidatų atradimas laisvos formos užduotims be `## Spec source`.
// Trys temos, trys kandidatai: bounded FS discovery (tikras tmpdir medis, kaip
// code-intelligence.test.ts), gryna BM25 atranka, gryna biudžeto atranka.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverControlDocCandidates,
  rankDiscoveredDocCandidates,
  selectDiscoveredDocs,
  CONTROL_DOC_ROOTS,
  type DiscoveredDocCandidate,
} from "../application/code-intelligence/retrieval/discovered-docs.js";
import { nodeFsTestPort } from "./helpers/node-fs-port.js";

async function withTempProject(build: (root: string) => Promise<void>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-discovered-docs-"));
  await build(root);
  return root;
}

test("discoverControlDocCandidates: skenuoja tik CONTROL_DOC_ROOTS, ignoruoja likusį medį", async () => {
  const root = await withTempProject(async (dir) => {
    await writeFile(
      path.join(dir, "README.md"),
      "Įvadinis tekstas prieš pirmą antraštę.\n\n# Projektas\n\nĮvadas.\n\n## Sekcija\n\nturinys.\n",
    );
    await mkdir(path.join(dir, "docs", "nested"), { recursive: true });
    await writeFile(path.join(dir, "docs", "guide.md"), "# Guide\n\nturinys.\n");
    await writeFile(path.join(dir, "docs", "nested", "deep.md"), "# Deep\n\ngilus turinys.\n");
    await writeFile(path.join(dir, "docs", "image.png"), "ne-markdown");
    // Ne CONTROL_DOC_ROOTS dalis — neturi patekti į kandidatus.
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "ignored.md"), "# Ignored\n\nneturėtų patekti.\n");
  });
  try {
    const candidates = await discoverControlDocCandidates(nodeFsTestPort, root);
    const refs = candidates.map((candidate) => candidate.ref).sort();

    assert.ok(refs.includes("README.md"), "root <root> gabalas naudoja plikas kelias be #anchor");
    assert.ok(refs.includes("README.md#Sekcija"));
    assert.ok(refs.includes("docs/guide.md#Guide"));
    assert.ok(refs.includes("docs/nested/deep.md#Deep"), "rekursija į pokatalogius");
    assert.ok(
      refs.every((ref) => !ref.startsWith("src/")),
      "šaknys, kurių nėra CONTROL_DOC_ROOTS, neskenuojamos",
    );
    assert.ok(
      refs.every((ref) => !ref.includes("image.png")),
      "ne-.md failai atmetami",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoverControlDocCandidates: nesama šaknis praleidžiama tyliai (absent, ne klaida)", async () => {
  const root = await withTempProject(async (dir) => {
    await writeFile(path.join(dir, "README.md"), "# Tik README\n\nturinys.\n");
  });
  try {
    // Šiame tmpdir'e nėra nei docs/, nei AG/spec, nei AG/openspec, nei .claude/rules —
    // discovery vis tiek turi baigtis be klaidos.
    const candidates = await discoverControlDocCandidates(nodeFsTestPort, root);
    assert.deepEqual(
      candidates.map((candidate) => candidate.ref),
      ["README.md#Tik README"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoverControlDocCandidates: deterministinė tvarka (failai keliu, gabalai — dokumento eilute)", async () => {
  const root = await withTempProject(async (dir) => {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "docs", "b.md"), "# B\n\nturinys b.\n");
    await writeFile(path.join(dir, "docs", "a.md"), "# A pirma\n\nturinys.\n\n## A antra\n\nturinys.\n");
  });
  try {
    const first = await discoverControlDocCandidates(nodeFsTestPort, root);
    const second = await discoverControlDocCandidates(nodeFsTestPort, root);
    assert.deepEqual(first, second, "tas pats medis visada duoda tą pačią seką");
    assert.deepEqual(
      first.map((candidate) => candidate.ref),
      ["docs/a.md#A pirma", "docs/a.md#A antra", "docs/b.md#B"],
      "failai rūšiuojami keliu (a.md prieš b.md), gabalai — dokumento eilute",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rankDiscoveredDocCandidates: nulinis BM25 balas atmeta kandidatą, o ne krenta į general_docs", () => {
  const candidates: DiscoveredDocCandidate[] = [
    { ref: "docs/artimas.md", text: "kontekstinio pack'o biudžetas ir retrieval" },
    { ref: "docs/nesusijes.md", text: "visai kitas dalykas apie nieką" },
  ];
  const ranked = rankDiscoveredDocCandidates(candidates, "context pack biudžetas");
  assert.deepEqual(
    ranked.map((candidate) => candidate.ref),
    ["docs/artimas.md"],
    "kandidatas be jokio lexinio ryšio su užklausa atmetamas visiškai",
  );
});

test("rankDiscoveredDocCandidates: didesnis BM25 balas laimi, lygūs balai laiko įvesties tvarką", () => {
  const candidates: DiscoveredDocCandidate[] = [
    { ref: "docs/silpnas.md", text: "biudžetas paminėtas kartą" },
    { ref: "docs/stiprus.md", text: "biudžetas biudžetas biudžetas kontekstas" },
    { ref: "docs/lygus-a.md", text: "biudžetas paminėtas kartą" },
    { ref: "docs/lygus-b.md", text: "biudžetas paminėtas kartą" },
  ];
  const ranked = rankDiscoveredDocCandidates(candidates, "biudžetas kontekstas");
  assert.deepEqual(ranked.map((candidate) => candidate.ref), [
    "docs/stiprus.md",
    "docs/silpnas.md",
    "docs/lygus-a.md",
    "docs/lygus-b.md",
  ]);
});

test("rankDiscoveredDocCandidates: tuščia užklausa arba tuščias korpusas neduoda nė vieno kandidato", () => {
  const candidates: DiscoveredDocCandidate[] = [{ ref: "docs/a.md", text: "bet koks turinys" }];
  assert.deepEqual(rankDiscoveredDocCandidates(candidates, ""), []);
  assert.deepEqual(rankDiscoveredDocCandidates([], "užklausa"), []);
});

test("selectDiscoveredDocs: biudžetas kerpa ties pastraipos riba ir žymi truncated", () => {
  const long = ["Pirma pastraipa su pakankamai teksto.", "Antra pastraipa, kuri nebetilps į likusį biudžetą visa."].join(
    "\n\n",
  );
  const ranked: DiscoveredDocCandidate[] = [{ ref: "docs/a.md", text: long }];
  const selection = selectDiscoveredDocs(ranked, 5, 45);

  assert.equal(selection.kept.length, 1);
  assert.equal(selection.truncated[0], "docs/a.md");
  assert.ok((selection.kept[0]?.text.length ?? 0) <= 45);
  assert.ok(long.startsWith(selection.kept[0]?.text ?? ""), "kirpimas — prefiksas, ne savavališka atkarpa");
});

test("selectDiscoveredDocs: maxCandidates riboja kiekį net kai biudžeto dar užtenka", () => {
  const ranked: DiscoveredDocCandidate[] = [
    { ref: "docs/a.md", text: "a" },
    { ref: "docs/b.md", text: "b" },
    { ref: "docs/c.md", text: "c" },
  ];
  const selection = selectDiscoveredDocs(ranked, 2, 1000);
  assert.deepEqual(
    selection.kept.map((candidate) => candidate.ref),
    ["docs/a.md", "docs/b.md"],
  );
  assert.deepEqual(selection.truncated, []);
});

test("selectDiscoveredDocs: pirmas kandidatas apkerpamas ir suvartoja likusį biudžetą, antram nelieka nieko", () => {
  // Tas pats principas kaip `applySpecFragmentBudget` (spec-fragments.ts): netelpantis
  // kandidatas apkarpomas iki likučio, o NE praleidžiamas dėl dydžio — „geriau 100% biudžeto
  // nutrūkusio teksto, nei tuščia vieta". Kai teksto be pastraipos lūžio, kirpimas grąžina
  // aklą langą (be `\n\n`/`\n` ribos), tad jis suvartoja VISĄ likusį biudžetą.
  const ranked: DiscoveredDocCandidate[] = [
    { ref: "docs/ilgas.md", text: "žodis be jokio pastraipos lūžio kuris viršija likutį" },
    { ref: "docs/trumpas.md", text: "tinka" },
  ];
  const selection = selectDiscoveredDocs(ranked, 5, 6);
  assert.deepEqual(
    selection.kept.map((candidate) => candidate.ref),
    ["docs/ilgas.md"],
  );
  assert.deepEqual(selection.truncated, ["docs/ilgas.md"]);
});

test("selectDiscoveredDocs: nulinis biudžetas nekeičia nieko", () => {
  const ranked: DiscoveredDocCandidate[] = [{ ref: "docs/a.md", text: "bet koks turinys" }];
  const selection = selectDiscoveredDocs(ranked, 5, 0);
  assert.deepEqual(selection.kept, []);
  assert.deepEqual(selection.truncated, []);
});

test("CONTROL_DOC_ROOTS: sąrašas uždaras ir stabilus (dokumentuotas kontraktas, ne atsitiktinumas)", () => {
  assert.deepEqual(CONTROL_DOC_ROOTS, ["README.md", "docs", "AG/spec", "AG/openspec", ".claude/rules"]);
});
