// Package/lockfile guard'o IO adapteris (etalonas: AG_loop hooks/package-guard.ts IO pusė).
// Sprendimas gyvena domain/policies/package-guard; čia — įrodymų rinkimas ir žurnalai.

import path from "node:path";
import {
  evaluatePackageGuard,
  lockfileNamesForManager,
  resolveTargetPackageManager,
  type PackageGuardEvidence,
  type PackageManagerName,
} from "../../domain/policies/index.js";
import type { ChangedFile } from "../../domain/git/changes.js";
import { consoleHookIo, type HookFsPort, type HookIo } from "./protocol.js";

const PACKAGE_MANAGER_NAMES: readonly PackageManagerName[] = ["npm", "yarn", "pnpm", "bun"];

/** Profilio vaizdas, kurio reikia Node target sprendimui — pilnas profilis nereikalingas. */
export type PackageGuardProfileView = {
  package_manager?: string | undefined;
  language?: string | undefined;
};

export type PackageGuardPorts = {
  fs: HookFsPort;
  /** Pakeisti failai su git statusu (changes.log + git status sąjunga). */
  collectChangedFilesWithStatus(projectRoot: string): Promise<ChangedFile[]>;
  /** Projekto profilis arba `undefined`, kai jo nėra/neperskaitomas. */
  loadProjectProfile(projectRoot: string): Promise<PackageGuardProfileView | undefined>;
  isGitRepository(projectRoot: string): Promise<boolean>;
  /** `git diff` eilutės šakniniam ir workspace `package.json` failams; klaida → []. */
  packageJsonDiffLines(projectRoot: string): Promise<string[]>;
  now?: () => Date;
};

export type PackageGuardDeps = {
  ports: PackageGuardPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  io?: HookIo;
};

/**
 * Ar target apskritai Node projektas (kitaip lockfile taisyklės beprasmės — task 886) ir, jei
 * taip, kuriuo valdikliu jis naudojasi. Pirmumas: profilio laukas > package.json#packageManager
 * > diske jau gulintis lockfile'as.
 */
async function resolveNodeTarget(
  deps: PackageGuardDeps,
  root: string,
): Promise<{ isNodeTarget: boolean; manager: PackageManagerName | undefined }> {
  const profile = await deps.ports.loadProjectProfile(root).catch(() => undefined);
  const rootPackageJson = await deps.ports.fs.readTextFileIfExists(path.join(root, "package.json"));

  const isNodeTarget =
    rootPackageJson !== undefined ||
    Boolean(profile?.package_manager) ||
    profile?.language === "typescript" ||
    profile?.language === "javascript";
  if (!isNodeTarget) return { isNodeTarget: false, manager: undefined };

  let declaredManager: string | undefined;
  if (rootPackageJson !== undefined) {
    try {
      declaredManager = (JSON.parse(rootPackageJson) as { packageManager?: string }).packageManager;
    } catch {
      // Sugadintas package.json nėra šio guard'o problema — jį pagaus typecheck/build.
      declaredManager = undefined;
    }
  }

  let existingRootLockfileManager: PackageManagerName | undefined;
  for (const manager of PACKAGE_MANAGER_NAMES) {
    for (const name of lockfileNamesForManager(manager)) {
      if (await deps.ports.fs.exists(path.join(root, name))) {
        existingRootLockfileManager = manager;
        break;
      }
    }
    if (existingRootLockfileManager) break;
  }

  return {
    isNodeTarget: true,
    manager: resolveTargetPackageManager({
      ...(profile?.package_manager === undefined ? {} : { profilePackageManager: profile.package_manager }),
      ...(declaredManager === undefined ? {} : { packageJsonPackageManager: declaredManager }),
      ...(existingRootLockfileManager === undefined ? {} : { existingRootLockfileManager }),
    }),
  };
}

/** Svetimo valdiklio lockfile'ai, realiai gulintys projekto šaknyje. */
async function foreignLockfilesOnDisk(
  deps: PackageGuardDeps,
  root: string,
  targetManager: PackageManagerName | undefined,
): Promise<string[]> {
  if (!targetManager) return [];
  const found: string[] = [];
  for (const manager of PACKAGE_MANAGER_NAMES) {
    if (manager === targetManager) continue;
    for (const lockfile of lockfileNamesForManager(manager)) {
      if (await deps.ports.fs.exists(path.join(root, lockfile))) found.push(lockfile);
    }
  }
  return found;
}

export async function hookPackageGuard(deps: PackageGuardDeps): Promise<number> {
  const io = deps.io ?? consoleHookIo;
  const root = path.resolve(deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");
  const logDir = path.join(runtimeRoot, "logs");
  const hooksLog = path.join(logDir, "hooks.log");
  const guardLog = path.join(logDir, "package-guard.log");
  const stamp = (): string => (deps.ports.now?.() ?? new Date()).toISOString();

  await deps.ports.fs.makeDirectory(logDir);

  const { isNodeTarget, manager } = await resolveNodeTarget(deps, root);
  // Sesijos rašymų ledger'is leidžia atskirti ŠIOS sesijos package.json pakeitimą nuo
  // lygiagrečios sesijos darbo toje pačioje darbo kopijoje.
  const ledgerRaw = await deps.ports.fs.readTextFileIfExists(path.join(runtimeRoot, "state", "session-writes.json"));
  let sessionWrites: string[] = [];
  try {
    const parsed = ledgerRaw === undefined ? [] : (JSON.parse(ledgerRaw) as unknown);
    sessionWrites = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    // Neperskaitomas ledger'is reiškia „nežinau, kas rašė" — tada nė vienas pakeitimas nėra
    // laikomas šios sesijos, ir reason vartai nesuveikia. Fail-open ČIA yra teisinga kryptis:
    // guard'as neturi blokuoti sesijos dėl savo pačios telemetrijos gedimo.
    sessionWrites = [];
  }

  const evidence: PackageGuardEvidence = {
    isNodeTarget,
    targetManager: manager,
    changed: await deps.ports.collectChangedFilesWithStatus(root),
    sessionWrites,
    foreignLockfilesOnDisk: isNodeTarget ? await foreignLockfilesOnDisk(deps, root, manager) : [],
    commitMessage: (await deps.ports.fs.readTextFileIfExists(path.join(logDir, "commit-msg.md"))) ?? "",
    packageDiffLines: (await deps.ports.isGitRepository(root)) ? await deps.ports.packageJsonDiffLines(root) : [],
  };

  const verdict = evaluatePackageGuard(evidence);
  await deps.ports.fs.writeTextFile(guardLog, `${verdict.lines.join("\n")}${verdict.lines.length ? "\n" : ""}`);
  for (const note of verdict.notes) {
    await deps.ports.fs.appendTextFile(hooksLog, `[${stamp()}] ${note}\n`);
  }

  if (verdict.block) {
    await deps.ports.fs.appendTextFile(hooksLog, `[${stamp()}] ${verdict.block.reason}\n`);
    io.error(verdict.block.stderr);
    io.error("Detalės: vq/logs/package-guard.log");
    return 1;
  }

  await deps.ports.fs.appendTextFile(hooksLog, `[${stamp()}] Package guard ✅ — package/lockfile pakeitimai leistini\n`);
  return 0;
}
