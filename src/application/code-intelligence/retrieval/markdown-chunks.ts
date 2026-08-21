// Markdown skaidymas pagal antraštes — spec fragmentų heading atitikimo pagrindas.
// Behaviour etalon: AG_loop rag-lite/chunker.ts chunkMarkdownByHeading (vienintelė gyva
// chunker'io dalis; indexControlMarkdown kelias — wont-migrate(dead), VQ-002 §3.5).

export type MarkdownChunk = {
  heading: string;
  level: number;
  text: string;
};

export function chunkMarkdownByHeading(markdown: string): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];
  let current: MarkdownChunk | undefined;
  const preface: string[] = [];

  for (const line of markdown.split(/\r?\n/)) {
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

    if (current) {
      current.text += `\n${line}`;
    } else {
      preface.push(line);
    }
  }

  if (current) {
    chunks.push({ ...current, text: current.text.trim() });
  } else if (preface.join("\n").trim()) {
    chunks.push({ heading: "<root>", level: 0, text: preface.join("\n").trim() });
  }

  return chunks.filter((chunk) => chunk.text.length > 0);
}
