// DB migracijų guard'o IO adapteris (etalonas: AG_loop hooks/migration-guard.ts IO pusė).
// SQL taisyklės ir verdiktas gyvena domain/policies/migration-guard.
//
// Guard'o žurnalas rašomas VISADA — ir tada, kai migracijų nekeista. Tuščias failas skaitytojui
// reikštų „guard'as nebėgo", o čia reikia atskirti tai nuo „bėgo ir nieko nerado".

import path from "node:path";
import {
  evaluateMigrationGuard,
  isMigrationFile,
  type MigrationGuardEvidence,
} from "../../domain/policies/index.js";
import type { ChangedFile } from "../../domain/git/changes.js";
import { consoleHookIo, type HookFsPort, type HookIo } from "./protocol.js";

export type MigrationGuardPorts = {
  fs: HookFsPort;
  collectChangedFilesWithStatus(projectRoot: string): Promise<ChangedFile[]>;
  isGitRepository(projectRoot: string): Promise<boolean>;
  /** `git -C <root> diff --cached --name-status` eilutės; klaida → []. */
  stagedNameStatusLines(projectRoot: string): Promise<string[]>;
  /** `git diff` eilutės šakniniam ir workspace `package.json` failams; klaida → []. */
  packageJsonDiffLines(projectRoot: string): Promise<string[]>;
  now?: () => Date;
};

export type MigrationGuardDeps = {
  ports: MigrationGuardPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  io?: HookIo;
};

export async function hookMigrationGuard(deps: MigrationGuardDeps): Promise<number> {
  const io = deps.io ?? consoleHookIo;
  const root = path.resolve(deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");
  const logDir = path.join(runtimeRoot, "logs");
  const hooksLog = path.join(logDir, "hooks.log");
  const guardLog = path.join(logDir, "migration-guard.log");
  const stamp = (): string => (deps.ports.now?.() ?? new Date()).toISOString();

  await deps.ports.fs.makeDirectory(logDir);

  const changed = await deps.ports.collectChangedFilesWithStatus(root);
  // Skaitomi tik migracijos failai ir tik tie, kurie realiai egzistuoja: ištrintam failui
  // turinio nėra, o jo trynimas ir taip yra atskira blokuojanti taisyklė.
  const contents: Record<string, string> = {};
  for (const { status, file } of changed) {
    if (!file || !isMigrationFile(file) || status.includes("D")) continue;
    const content = await deps.ports.fs.readTextFileIfExists(path.join(root, file));
    if (content !== undefined) contents[file] = content;
  }

  const isGitRepo = await deps.ports.isGitRepository(root);
  const evidence: MigrationGuardEvidence = {
    changed,
    contents,
    stagedNameStatusLines: isGitRepo ? await deps.ports.stagedNameStatusLines(root) : [],
    packageDiffLines: isGitRepo ? await deps.ports.packageJsonDiffLines(root) : [],
    commitMessage: (await deps.ports.fs.readTextFileIfExists(path.join(logDir, "commit-msg.md"))) ?? "",
  };

  const verdict = evaluateMigrationGuard(evidence);
  await deps.ports.fs.writeTextFile(guardLog, `${verdict.lines.join("\n")}${verdict.lines.length ? "\n" : ""}`);

  if (!verdict.migrationChanged) {
    await deps.ports.fs.appendTextFile(
      hooksLog,
      `[${stamp()}] Migration guard praleistas — migracijos/schema nekeistos\n`,
    );
    return 0;
  }

  if (verdict.block) {
    await deps.ports.fs.appendTextFile(hooksLog, `[${stamp()}] ${verdict.block.reason}\n`);
    io.error(verdict.block.stderr);
    io.error("Detalės: vq/logs/migration-guard.log");
    return 1;
  }

  // Leistas destruktyvus pakeitimas pažymimas ATSKIRAI — tai audito pėdsakas, be kurio
  // patvirtinto destruktyvaus veiksmo nebūtų kaip atsekti žurnale.
  await deps.ports.fs.appendTextFile(
    hooksLog,
    verdict.destructive
      ? `[${stamp()}] Migration guard: destruktyvus pakeitimas leistas su Migration approved\n`
      : `[${stamp()}] Migration guard ✅ — tik jautrūs arba saugūs migracijos pakeitimai\n`,
  );
  return 0;
}
