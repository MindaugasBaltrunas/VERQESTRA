// API kontrakto juodraščio eksportas iš aktyvios spec (etalonas: AG_loop
// spec/api-contract-export.ts, WBR VQ-501 3/5-a). Aktyvi spec randama ta pačia
// findActiveSpec taisykle kaip task-planning generate; „## API Contract" sekcijos
// renkamos iš spec markdown failų, endpoint eilutės parse'inamos deterministiškai.
// IO — per portą; numatytasis output kelias — `vq/generated/api-contract.json`
// (VERQESTRA runtime šaknis; etalone — `AG/generated/`).

import path from "node:path";
import { toPosixPath } from "../../shared/paths.js";
import { findActiveSpec, type TaskPlanningFsPort } from "./spec-source.js";

export type ApiContractEndpoint = {
  method: string;
  path: string;
  summary: string;
};

export type ApiContractSection = {
  source: string;
  heading: string;
  text: string;
};

export type ApiContractDraft = {
  version: "0.1.0";
  kind: "ag-api-contract-draft";
  spec_id: string;
  generated_from: string;
  endpoints: ApiContractEndpoint[];
  source_sections: ApiContractSection[];
};

export type ApiContractExportResult = {
  outputPath: string;
  contract: ApiContractDraft;
};

export type ApiContractExportPorts = {
  fs: TaskPlanningFsPort;
  /** Sukuria tėvinius katalogus ir įrašo tekstą (etalono mkdir recursive + writeFile). */
  writeTextFile(absolutePath: string, text: string): Promise<void>;
};

const specMarkdownFiles = ["proposal.md", "requirements.md", "design.md", "acceptance.md"];

export async function exportActiveApiContract(
  ports: ApiContractExportPorts,
  projectRoot: string,
  outputPath?: string,
): Promise<ApiContractExportResult> {
  const root = path.resolve(projectRoot);
  const activeSpec = await findActiveSpec(ports.fs, root);
  const sections = await readApiContractSections(ports.fs, root, activeSpec.changeDir);
  if (sections.length === 0) {
    throw new Error(`No API contract section found in active spec ${activeSpec.id}`);
  }

  const endpoints = sections.flatMap((section) => parseEndpointLines(section.text));
  if (endpoints.length === 0) {
    throw new Error(`API contract section found in active spec ${activeSpec.id}, but no endpoints were parseable`);
  }

  const contract: ApiContractDraft = {
    version: "0.1.0",
    kind: "ag-api-contract-draft",
    spec_id: activeSpec.id,
    generated_from: toPosixPath(activeSpec.relativeSpecPath),
    endpoints,
    source_sections: sections,
  };

  const targetPath = outputPath ?? path.join(root, "vq", "generated", "api-contract.json");
  await ports.writeTextFile(targetPath, `${JSON.stringify(contract, null, 2)}\n`);
  return { outputPath: targetPath, contract };
}

export function parseEndpointLines(text: string): ApiContractEndpoint[] {
  const endpoints: ApiContractEndpoint[] = [];
  for (const line of text.split(/\r?\n/)) {
    const normalized = line.trim().replace(/^[-*]\s+/, "");
    const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s+[-–—]\s+(.+))?$/i.exec(normalized);
    if (!match) continue;
    endpoints.push({
      method: match[1]!.toUpperCase(),
      path: match[2]!,
      summary: match[3]?.trim() || "",
    });
  }
  return endpoints;
}

async function readApiContractSections(
  fs: TaskPlanningFsPort,
  projectRoot: string,
  changeDir: string,
): Promise<ApiContractSection[]> {
  const sections: ApiContractSection[] = [];
  for (const fileName of specMarkdownFiles) {
    const filePath = path.join(changeDir, fileName);
    const text = await fs.readTextFileIfExists(filePath);
    if (text === undefined) continue;
    for (const section of markdownSections(text, /^##\s+API Contract\s*$/i)) {
      sections.push({
        source: toPosixPath(path.relative(projectRoot, filePath)),
        heading: section.heading,
        text: section.text,
      });
    }
  }
  return sections;
}

function markdownSections(text: string, headingPattern: RegExp): Array<{ heading: string; text: string }> {
  const lines = text.split(/\r?\n/);
  const sections: Array<{ heading: string; text: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index] ?? "";
    if (!headingPattern.test(heading.trim())) continue;

    const body: string[] = [];
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const line = lines[bodyIndex] ?? "";
      if (/^#{1,6}\s/.test(line)) break;
      body.push(line);
    }
    sections.push({ heading: heading.trim(), text: body.join("\n").trim() });
  }

  return sections;
}
