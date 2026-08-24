// 2026-08-24 RAG auditas 6 — sekcijų skaitytojų SUTARIMAS prieš šio repo tikrus dokumentus.
//
// Auditas 5 nustatė invariantą: `extractSection` ir `enumerateTaskSections` yra dvi to paties
// klausimo pusės ir privalo matyti TĄ PAČIĄ ribą. Sintetiniai testai jį tikrina pasirinktais
// atvejais; šis — prieš korpusą, kuris realiai egzistuoja, realiai keičiasi, ir kurį `## Spec
// source` gali nurodyti kaip įrodymą.
//
// KO ŠIS FAILAS NEDENGIA, ir tai užrašyta sąmoningai: patikrinta, kad šiandien NĖ VIENAS repo
// dokumentas (`README.md`, `CLAUDE.md`, `docs/**`, `.claude/**`, `AG/openspec/**`, `templates/**`)
// neturi ATX antraštės fenced bloko viduje. Fence aklumo klasė yra reali (žr. auditus 4 ir 5), bet
// šio repo korpusas jos NEIŠPROVOKUOJA, tad fence atvejai lieka sintetiniuose testuose
// (`markdown-section-bounds`, `shared-markdown`). Čia tikrinamas tik tas invariantas, kurį šis
// korpusas realiai gali sulaužyti — dviejų skaitytojų nesutarimas.
import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { extractSection } from "../shared/markdown.js";
import { enumerateTaskSections } from "../domain/tasks/sections.js";

/** Šaknys — dokumentacija ir spec šaltiniai, t. y. tie failai, kuriuos RAG gali paimti. */
const CORPUS_ROOTS = ["docs", ".claude", "AG/openspec", "templates"];
const CORPUS_FILES = ["README.md", "CLAUDE.md"];

async function collectMarkdown(absoluteDir: string, repoRoot: string, into: string[]): Promise<void> {
  const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolute = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      await collectMarkdown(absolute, repoRoot, into);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      into.push(path.relative(repoRoot, absolute).split(path.sep).join("/"));
    }
  }
}

async function readCorpus(): Promise<{ file: string; text: string }[]> {
  const repoRoot = process.cwd();
  const files = [...CORPUS_FILES];
  for (const root of CORPUS_ROOTS) {
    await collectMarkdown(path.resolve(repoRoot, ...root.split("/")), repoRoot, files);
  }

  const documents: { file: string; text: string }[] = [];
  for (const file of files) {
    const text = await readFile(path.resolve(repoRoot, ...file.split("/")), "utf8").catch(() => undefined);
    if (text !== undefined) {
      documents.push({ file, text });
    }
  }
  return documents;
}

const corpus = await readCorpus();

// Vartas PAČIAM testui: korpusas atrandamas, tad jis gali tyliai susitraukti iki nulio (pervadinti
// katalogai, pakeista struktūra), ir tada žemiau esantis tikrinimas liktų žalias nieko netikrindamas.
test("korpusas nėra tuščias", () => {
  assert.ok(corpus.length >= 10, `atrasta tik ${corpus.length} dokumentų — korpuso šaknys nebeatitinka repo`);
});

test("extractSection ir enumerateTaskSections sutaria dėl kiekvienos realios sekcijos", () => {
  for (const { file, text } of corpus) {
    const sections = enumerateTaskSections(text);
    // `extractSection` grąžina PIRMĄ atitikmenį, tad lyginami tik unikalūs antraščių tekstai:
    // pasikartojanti antraštė yra dviprasmiška pagal konstrukciją, ne skaitytojų nesutarimas.
    const occurrences = new Map<string, number>();
    for (const section of sections) {
      occurrences.set(section.heading, (occurrences.get(section.heading) ?? 0) + 1);
    }
    for (const section of sections) {
      if (!section.heading || (occurrences.get(section.heading) ?? 0) > 1) {
        continue;
      }
      assert.equal(
        extractSection(text, section.heading),
        section.body,
        `${file}: dvi sekcijos ribos išsiskyrė ties ${section.heading}`,
      );
    }
  }
});
