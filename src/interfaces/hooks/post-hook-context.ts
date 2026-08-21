// Bendras `PostToolUse` hook'ų kontekstas: portai, keliai ir žurnalo eilutė. Atskirtas nuo
// pačių hook'ų, nes tuos pačius portus naudoja ir Bash/Read pusė (`post-hooks.ts`), ir rašymo
// pusė (`post-write.ts`), o vienas failas abiem netilptų į dydžio vartus.

import path from "node:path";
import type { ContextCompressionConfig } from "../../domain/policies/compression/features.js";
import type { LedgerFsPort } from "./ledger-lock.js";
import { consoleHookIo, type HookFsPort, type HookIo, type HookStdinPort } from "./protocol.js";

/** Ledger'io portas plius append'as — vienas Node adapteris tenkina abu. */
export type PostHookFsPort = LedgerFsPort & Pick<HookFsPort, "appendTextFile">;

export type PostHookProcessResult = { code: number; stdout: string };

export type PostHookPorts = {
  fs: PostHookFsPort;
  stdin: HookStdinPort;
  /**
   * Konteksto kompresijos konfigas. Klaida PRIVALO virsti `undefined` (funkcija išjungta), nes
   * PostToolUse hook'e išimtis reiškia užblokuotą tool call'ą.
   */
  loadCompressionConfig(runtimeRoot: string): Promise<ContextCompressionConfig | undefined>;
  /**
   * `git status --porcelain --untracked-files=all --ignored=matching -- <path>` projekto
   * šaknyje. Portas SIAURAS sąmoningai: kelias eina į komandos argumentus, tad laisvos formos
   * shell eilutė čia būtų injekcijos primityvas.
   */
  gitStatusForPath(projectRoot: string, relativePath: string): Promise<PostHookProcessResult>;
  /** Aplinkos kintamasis (dispatch nonce). Portas — kad testas neliestų `process.env`. */
  env(name: string): string | undefined;
  now?: () => Date;
};

export type PostHookDeps = {
  ports: PostHookPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  io?: HookIo;
  /**
   * Readme įrodymo lock deadline. Egzistuoja TIK tam, kad testas įrodytų deadline išsekimo kelią
   * nelaukdamas realių sekundžių; produkcinis kelias visada naudoja numatytąjį.
   */
  readEventLockWaitMs?: number;
};

export type PostHookContext = {
  deps: PostHookDeps;
  io: HookIo;
  root: string;
  runtimeRoot: string;
  now(): Date;
  log(line: string): Promise<void>;
};

export function hookLogPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "logs", "hooks.log");
}

export function changesLogPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "logs", "changes.log");
}

export function runtimeLogPath(context: PostHookContext, fileName: string): string {
  return path.join(context.runtimeRoot, "logs", fileName);
}

export function runtimeStatePath(context: PostHookContext, fileName: string): string {
  return path.join(context.runtimeRoot, "state", fileName);
}

export function readEventsPath(context: PostHookContext): string {
  return runtimeStatePath(context, "readme-read-events.json");
}

export function postHookContext(deps: PostHookDeps): PostHookContext {
  const io = deps.io ?? consoleHookIo;
  const root = path.resolve(deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");
  const now = (): Date => deps.ports.now?.() ?? new Date();
  return {
    deps,
    io,
    root,
    runtimeRoot,
    now,
    // Žurnalo rašymas NIEKADA nemeta: PostToolUse hook'e išimtis yra exit 2, t. y. užblokuotas
    // tool call'as, o žurnalo eilutė yra stebėjimas, ne kontrolė.
    log: async (line: string): Promise<void> => {
      await deps.ports.fs
        .appendTextFile(hookLogPath(runtimeRoot), `[${now().toISOString()}] ${line}\n`)
        .catch(() => undefined);
    },
  };
}

/**
 * Kelias repo-santykine forward-slash forma. Absoliutus kelias už projekto ribų lieka
 * `..`-formos ir taip pasiekia `isOutsideProjectPath` vartus, o santykinis paliekamas toks,
 * koks atėjo — hook payload'e jis jau yra repo formos.
 */
export function relativeToProject(context: PostHookContext, filePath: string): string {
  if (!filePath) return "";
  const nativePath = filePath.replace(/\//g, path.sep);
  const relativePath = path.isAbsolute(nativePath) ? path.relative(context.root, nativePath) : filePath;
  return relativePath.replace(/\\/g, "/").replace(/^\.?\//, "");
}
