// Spec fragmentų paėmimas pagal task'o ref'us (`path` arba `path#heading`) su char budget'u.
// Behaviour etalon: AG_loop rag-lite/retriever.ts retrieveSpecFragments (gyvoji pusė);
// FS — per portą (WBR VQ-301). retrieveRelevantChunks kelias — wont-migrate(dead).

import path from "node:path";
import type { CodeIntelligenceFileSystemPort } from "../ports.js";
import { chunkMarkdownByHeading } from "./markdown-chunks.js";

// Spec source gali būti change KATALOGAS (pvz. "AG/openspec/changes/<id>/") — katalogo
// skaitymas kaip failo mestų EISDIR ir anksčiau nuversdavo visą context pack'ą, siųsdamas
// šiaip validžius taskus į human review. Katalogo nuoroda todėl išskleidžiama į
// konvencinius change failus ta pačia tvarka kaip spec konteksto skaitytuvas.
const CHANGE_DIR_FILES = ["proposal.md", "tasks.md", "spec.md", "design.md"];

export type RetrievedFragment = {
  ref: string;
  text: string;
  // Set to the requested heading text when `ref` asked for `#heading` on a markdown
  // file and no chunk matched it. Callers must surface this instead of treating the
  // whole-file fallback below as a silent, unbounded expansion.
  headingMiss?: string;
};

export async function retrieveSpecFragments(
  fs: CodeIntelligenceFileSystemPort,
  projectRoot: string,
  refs: string[],
  maxFragments: number,
  maxChars: number,
): Promise<RetrievedFragment[]> {
  const fragments: RetrievedFragment[] = [];
  let usedChars = 0;

  for (const ref of refs.slice(0, maxFragments)) {
    const hashIndex = ref.indexOf("#");
    const filePart = (hashIndex === -1 ? ref : ref.slice(0, hashIndex)).trim();
    const headingRef = hashIndex === -1 ? "" : ref.slice(hashIndex + 1).trim();
    if (!filePart) {
      continue;
    }

    let filePath = path.resolve(projectRoot, filePart);
    if (!(await fs.exists(filePath))) {
      continue;
    }

    const isDirectory = await isDirectoryPath(fs, filePath);
    if (isDirectory) {
      // Katalogas be konvencinių change failų tyliai praleidžiamas — kaip ir
      // neegzistuojantis ref; fragmentas skaitomas iš pirmo rasto failo.
      let resolved: string | undefined;
      for (const candidate of CHANGE_DIR_FILES) {
        const candidatePath = path.join(filePath, candidate);
        if (await fs.exists(candidatePath)) {
          resolved = candidatePath;
          break;
        }
      }
      if (!resolved) {
        continue;
      }
      filePath = resolved;
    }

    const fullText = (await fs.readTextFile(filePath)).trim();
    const isMarkdown = filePart.toLowerCase().endsWith(".md");
    const matchedSection = headingRef && isMarkdown ? matchHeadingSection(fullText, headingRef) : undefined;
    const headingMiss = headingRef && isMarkdown && matchedSection === undefined ? headingRef : undefined;
    const text = matchedSection ?? fullText;

    const remaining = maxChars - usedChars;
    if (remaining <= 0) {
      break;
    }

    const clipped = text.length > remaining ? text.slice(0, remaining) : text;
    fragments.push({ ref, text: clipped, ...(headingMiss ? { headingMiss } : {}) });
    usedChars += clipped.length;
  }

  return fragments;
}

// Portas neturi atskiro stat metodo: katalogą atpažįstame per listDirectory — failui jis
// grąžina tuščią sąrašą, bet failas nėra katalogas, tad tikriname per klaidingą skaitymą?
// Ne — kontraktas paprastesnis: katalogas = egzistuoja IR readTextFile jam mestų. Kadangi
// portui to garantuoti negalime be papildomo metodo, čia naudojamas listDirectory su
// vienareikšme taisykle: TIK katalogas turi bent potencialų turinį; failui adapteris
// privalo grąžinti tuščią sąrašą, o katalogui — įrašus arba tuščią sąrašą. Dviprasmybę
// (tuščias katalogas vs failas) išsprendžia isDirectoryEntry žyma tėviniame kataloge.
async function isDirectoryPath(fs: CodeIntelligenceFileSystemPort, absolutePath: string): Promise<boolean> {
  const parent = path.dirname(absolutePath);
  const name = path.basename(absolutePath);
  const entries = await fs.listDirectory(parent);
  return entries.some((entry) => entry.name === name && entry.isDirectory);
}

function matchHeadingSection(markdown: string, headingRef: string): string | undefined {
  const normalizedRef = normalizeHeading(headingRef);
  if (!normalizedRef) {
    return undefined;
  }

  const chunks = chunkMarkdownByHeading(markdown);
  return chunks.find((chunk) => normalizeHeading(chunk.heading) === normalizedRef)?.text;
}

function normalizeHeading(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
