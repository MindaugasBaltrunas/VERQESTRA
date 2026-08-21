// VQ-40A auditas (WBR-4 acceptance #5) — antras context/token matavimas su REALIU
// context-pack assembly per produkcinius E4 adapterius: nodeFsAdapter dengia
// ContextPackFileSystemPort, createCodeIntelligenceFsAdapter — CodeIntelligenceFileSystemPort.
// Skirtingai nuo context-pack-assemble.test.ts (testų helper portai — portų kontrakto
// etalonas), čia pack'ą surenka TIE PATYS adapteriai, kuriuos gaus E5 kompozicija.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { assembleContextPack } from "../application/context-pack/assemble/assemble.js";
import type { ContextPackFileSystemPort } from "../application/context-pack/ports.js";
import type { CodeIntelligenceFileSystemPort } from "../application/code-intelligence/ports.js";
import { buildCodeIndex } from "../application/code-intelligence/indexing/builder.js";
import { DEFAULT_CONTEXT_BUDGET } from "../application/policy-governance/context-budget.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { createCodeIntelligenceFsAdapter } from "../infrastructure/fs/code-intelligence-fs-adapter.js";

// KRYPTIES ĮRODYMO dalis, kuri kompiliuojasi arba ne: produkciniai adapteriai privalo
// STRUKTŪRIŠKAI tenkinti E3 portus be jokių wrapper'ių. Jei portas pasikeis nesuderinamai,
// šios dvi eilutės sulaužys typecheck dar prieš bet kokį runtime testą.
const contextPackFs: ContextPackFileSystemPort = nodeFsAdapter;
// code-intelligence adapteris yra ŠAKNIES APIMTIES (containment vartas), tad kontraktą
// tenkina jo gamykla, ne singleton'as.
const makeCodeFs: (projectRoot: string) => CodeIntelligenceFileSystemPort = createCodeIntelligenceFsAdapter;

const root = await mkdtemp(path.join(tmpdir(), "vq-40a-real-"));
const codeFs = makeCodeFs(root);
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const TASK_MARKDOWN = [
  "# Task",
  "",
  "## Spec source",
  "doc/spec.md#alfa",
  "",
  "## Tikslas",
  "Įgyvendinti demo modulio pakeitimą.",
  "",
  "## Agentai",
  "readme-guard -> coder -> tester",
  "",
  "## Failai",
  "Leidžiama:",
  "- `src/module/a.ts`",
  "Draudžiama:",
  "- `.env*`",
  "",
  "## Veiksmas",
  "- Pakeisti eksportą.",
  "- Padengti testu.",
  "",
  "## Patikra",
  "- `pnpm test`",
  "",
  "## Stop",
  "Kai patikros žalios, sustok.",
  "",
].join("\n");

test("VQ-40A: realus assembly per nodeFsAdapter + codeIntelligenceFsAdapter — pack telpa į biudžetą ir yra deterministiškas", async () => {
  await nodeFsAdapter.writeTextFile(path.join(root, "AG", "tasks", "queue", "0042-demo.md"), TASK_MARKDOWN);
  await nodeFsAdapter.writeTextFile(path.join(root, "doc", "spec.md"), "# Alfa\nalfa spec tekstas\n# Beta\nbeta\n");
  await nodeFsAdapter.writeTextFile(
    path.join(root, "src", "module", "a.ts"),
    'export function demo(): string {\n  return "x";\n}\n',
  );

  // Indeksas iš anksto per PRODUKCINĮ code-intelligence adapterį — abu surinkimai eina
  // "fresh" keliu ir determinizmo palyginimas lygina vienodos kilmės pack'us.
  await buildCodeIndex(codeFs, root);

  const deps = { fs: contextPackFs, codeFs };
  const result = await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);

  assert.equal(result.pack.task_id, "0042-demo");
  assert.equal(result.pack.goal, "Įgyvendinti demo modulio pakeitimą.");
  assert.deepEqual(result.pack.allowed_paths, ["src/module/a.ts"]);
  assert.equal(result.pack.code_context?.enabled, true, "esamas taikinys → code context per realų adapterį");

  // MATAVIMAS: persist'intas pack'as telpa į kontekstinį biudžetą (chars — token'ų proxy,
  // ta pati chars/4 heuristika kaip VQ-30A audito skaičiuose).
  const packJson = (await nodeFsAdapter.readTextFileIfExists(result.outputPath))!;
  assert.ok(packJson.length > 0, "pack'as persist'intas");
  assert.ok(
    packJson.length <= DEFAULT_CONTEXT_BUDGET.max_context_chars,
    `pack ${packJson.length} chars viršija biudžetą ${DEFAULT_CONTEXT_BUDGET.max_context_chars}`,
  );

  // Telemetrija parašyta per tą patį adapterį (vq/logs/context-size.jsonl).
  const metricsRaw = (await nodeFsAdapter.readTextFileIfExists(path.join(root, "vq", "logs", "context-size.jsonl")))!;
  const record = JSON.parse(metricsRaw.trim().split("\n").at(-1)!) as Record<string, unknown>;
  assert.equal(record["task_id"], "0042-demo");

  // Determinizmas su realiu adapteriu: pakartotinis surinkimas — byte-identiškas pack'as.
  const second = await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);
  assert.equal(await nodeFsAdapter.readTextFileIfExists(second.outputPath), packJson);
});
