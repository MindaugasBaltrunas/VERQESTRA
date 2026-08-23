// Markdown skaidymas pagal antraštes — spec fragmentų heading atitikimo pagrindas.
// Behaviour etalon: AG_loop rag-lite/chunker.ts chunkMarkdownByHeading (vienintelė gyva
// chunker'io dalis; indexControlMarkdown kelias — wont-migrate(dead), VQ-002 §3.5).
//
// ## NUKRYPIMAS (griežtinantis, 2026-08-23 RAG auditas): fenced code blokai nėra antraštės
//
// Etalonas kiekvieną `# ...` eilutę laikė antrašte, įskaitant eilutes FENCED CODE bloko
// viduje. Spec dokumentuose tai kasdienybė: bash `# komentaras`, YAML `# pastaba` ar
// Mermaid tekstas ``` bloke virsdavo fantomine 1 lygio „antrašte", ir prašyta sekcija
// (`## API` su savo poskyriais) būdavo TYLIAI nukertama ties ja — be jokio `headingMiss`,
// nes prašyta antraštė rasta, tik jos turinys nepilnas. Fantominis gabalas taip pat galėjo
// KLAIDINGAI atitikti prašytą antraštę. Dabar fence viduje (``` arba ~~~; CommonMark
// uždarymas — tiek pat ar daugiau tų pačių ženklų be info string) antraščių neieškoma —
// eilutės keliauja į einamą gabalą kaip turinys.

export type MarkdownChunk = {
  heading: string;
  level: number;
  text: string;
};

type OpenFence = { marker: string; length: number };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

// CommonMark uždarymo fence: bent tiek pat TO PATIES ženklo, jokio info string.
function isFenceClose(line: string, open: OpenFence): boolean {
  const marks = line.match(FENCE_CLOSE)?.[1];
  return marks !== undefined && (marks[0] ?? "") === open.marker && marks.length >= open.length;
}

export function chunkMarkdownByHeading(markdown: string): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];
  let current: MarkdownChunk | undefined;
  const preface: string[] = [];
  let openFence: OpenFence | undefined;

  const appendLine = (line: string): void => {
    if (current) {
      current.text += `\n${line}`;
    } else {
      preface.push(line);
    }
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (openFence !== undefined) {
      if (isFenceClose(line, openFence)) {
        openFence = undefined;
      }
      appendLine(line);
      continue;
    }

    const fence = line.match(FENCE_OPEN)?.[1];
    if (fence !== undefined) {
      openFence = { marker: fence[0] ?? "`", length: fence.length };
      appendLine(line);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      if (current) {
        chunks.push({ ...current, text: current.text.trim() });
      } else if (preface.join("\n").trim()) {
        chunks.push({ heading: "<root>", level: 0, text: preface.join("\n").trim() });
      }

      current = {
        heading: (heading[2] ?? "").trim(),
        level: (heading[1] ?? "").length,
        text: line,
      };
      continue;
    }

    appendLine(line);
  }

  if (current) {
    chunks.push({ ...current, text: current.text.trim() });
  } else if (preface.join("\n").trim()) {
    chunks.push({ heading: "<root>", level: 0, text: preface.join("\n").trim() });
  }

  return chunks.filter((chunk) => chunk.text.length > 0);
}
