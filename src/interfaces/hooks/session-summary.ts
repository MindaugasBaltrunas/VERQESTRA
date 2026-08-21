// Sesijos santrauka (etalonas: AG_loop hooks/session-summary.ts) — skaitoma žmogaus ataskaita
// iš hook'ų žurnalo ir git būsenos.
//
// Kiekviena „Checks" eilutė remiasi {@link latestStatus}: laimi PASKUTINĖ atitinkanti eilutė, o
// be atitikmenų — NOT RUN / UNKNOWN. Nepaleista patikra niekada neturi atrodyti žalia, tad
// spėjimų čia nėra.

import path from "node:path";
import { latestStatus } from "./log-rotation.js";
import { sessionChangedFiles, type SessionChangesPorts } from "./session-changes.js";
import { consoleHookIo, type HookFsPort, type HookIo } from "./protocol.js";

const GUARD_LOG_FILES = [
  "secret-scan.log",
  "package-guard.log",
  "migration-guard.log",
  "frontend-guard.log",
  "backend-guard.log",
  "mobile-guard.log",
  "mobile-ts.log",
  "frontend-lint.log",
  "typecheck.log",
];

const COMMAND_LINE_PATTERN = /\] (bash|JAUTRI leidžiama): /;
const TEST_COMMAND_PATTERN = /\b(pnpm|npm|yarn|vitest|jest|playwright)[^\r\n]*(test|vitest|jest|playwright)\b/i;

export type SessionSummaryPorts = SessionChangesPorts & {
  fs: HookFsPort & {
    /** Failo dydis baitais arba `undefined`, kai failo nėra. */
    fileSizeBytes(absolutePath: string): Promise<number | undefined>;
  };
  isGitRepository(projectRoot: string): Promise<boolean>;
  /** `git status --porcelain` tekstas; tuščias = švarus medis. */
  gitStatusText(projectRoot: string): Promise<string>;
  now?: () => Date;
};

export type SessionSummaryDeps = {
  ports: SessionSummaryPorts;
  projectRoot: string;
  runtimeRoot?: string;
  io?: HookIo;
};

/** Sėkmingos santraukos exit kodas. Santrauka yra ataskaita — ji niekada neblokuoja. */
export const SESSION_SUMMARY_OK_EXIT_CODE = 0;

async function changedFilesSection(
  ports: SessionSummaryPorts,
  projectRoot: string,
  runtimeRoot: string,
): Promise<string[]> {
  if (!(await ports.isGitRepository(projectRoot))) return ["- Git repository unavailable"];

  const status = await ports.gitStatusText(projectRoot);
  if (status.trim()) return status.split(/\r?\n/).filter(Boolean).map((line) => `- ${line}`);

  // Švarus medis: commit'inusiai sesijai Stop hook'as `changes.log` jau išvalė, tad krentama į
  // sesijos apimties nuotrauką — kitaip sucommit'inti failai dingtų iš ataskaitos.
  const changed = (await sessionChangedFiles(ports, projectRoot, runtimeRoot)).slice(0, 100);
  return changed.length > 0 ? changed.map((file) => `- ${file}`) : ["- None recorded"];
}

function commandsSection(hooksLines: readonly string[]): string[] {
  const commands = hooksLines
    .filter((line) => COMMAND_LINE_PATTERN.test(line))
    .map((line) => `- ${line.replace(/^.*\] (bash|JAUTRI leidžiama): /, "")}`)
    .filter((line) => line !== "- ")
    .slice(-50);
  return commands.length > 0 ? commands : ["- None recorded"];
}

function checksSection(hooksLines: readonly string[]): string[] {
  const lines = [
    `- typecheck: ${latestStatus(hooksLines, /TypeScript OK/i, /TypeScript klaid|STOP BLOKUOTAS — [0-9?]+ TypeScript/i)}`,
    `- frontend lint: ${latestStatus(hooksLines, /Frontend guard OK|Frontend lint praleistas/i, /FRONTEND GUARD BLOKUOTAS|Frontend lint nepraėjo/i)}`,
    `- backend lint: ${latestStatus(hooksLines, /backend lint|eslint src/i, /backend.*lint.*(Exit status 1|failed)/i)}`,
  ];

  const testCommands = hooksLines.filter(
    (line) => COMMAND_LINE_PATTERN.test(line) && TEST_COMMAND_PATTERN.test(line),
  );
  if (testCommands.length === 0) {
    lines.push("- tests: NOT RUN / UNKNOWN");
  } else {
    // „RAN / CHECK LOGS", o ne „PASSED": žurnalo eilutė įrodo paleidimą, ne rezultatą, ir
    // ataskaita neturi teisės to skirtumo nutrinti.
    const failed = testCommands.some((line) => /(fail|failed|nepavyko|Exit status 1)/i.test(line));
    lines.push(failed ? "- tests: FAILED" : "- tests: RAN / CHECK LOGS");
  }
  return lines;
}

async function guardLogsSection(ports: SessionSummaryPorts, logsDir: string): Promise<string[]> {
  const lines: string[] = [];
  for (const file of GUARD_LOG_FILES) {
    const size = await ports.fs.fileSizeBytes(path.join(logsDir, file));
    if (size !== undefined) lines.push(`- ${file} (${size} bytes)`);
  }
  return lines;
}

export async function hookSessionSummary(deps: SessionSummaryDeps): Promise<number> {
  const ports = deps.ports;
  const io = deps.io ?? consoleHookIo;
  const root = path.resolve(deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");
  const logsDir = path.join(runtimeRoot, "logs");
  const hooksLog = path.join(logsDir, "hooks.log");
  const summaryFile = path.join(logsDir, "session-summary.md");
  const stamp = (ports.now?.() ?? new Date()).toISOString();

  await ports.fs.makeDirectory(logsDir);
  const hooksText = (await ports.fs.readTextFileIfExists(hooksLog)) ?? "";
  const hooksLines = hooksText ? hooksText.split(/\r?\n/) : [];

  const output = [
    "# Session Summary",
    "",
    `- Generated: ${stamp}`,
    `- Project: ${root}`,
    "",
    "## Changed Files",
    ...(await changedFilesSection(ports, root, runtimeRoot)),
    "",
    "## Commands",
    ...commandsSection(hooksLines),
    "",
    "## Checks",
    ...checksSection(hooksLines),
    "",
    "## Blocked Actions",
    ...blockedSection(hooksLines),
    "",
    "## Guard Logs",
    ...(await guardLogsSection(ports, logsDir)),
  ];

  await ports.fs.writeTextFile(summaryFile, `${output.join("\n")}\n`);
  await ports.fs.appendTextFile(hooksLog, `[${stamp}] session-summary parašyta: vq/logs/session-summary.md\n`);
  await ports.fs.appendTextFile(
    path.join(logsDir, "history.log"),
    `[${stamp}] SESSION_SUMMARY — vq/logs/session-summary.md\n`,
  );
  io.out(`session-summary: ${summaryFile}`);
  return SESSION_SUMMARY_OK_EXIT_CODE;
}

function blockedSection(hooksLines: readonly string[]): string[] {
  const blocked = hooksLines.filter((line) => /BLOKUOTAS|BLOCKED/.test(line)).slice(-30);
  return blocked.length > 0 ? blocked.map((line) => `- ${line}`) : ["- None recorded"];
}
