// Produkto formos guard'ų surišimas (etalonas: AG_loop hooks/{backend,frontend,mobile}-guard.ts
// hook pusė). Taisyklės gyvena domain/policies/scope-guard-rules, orkestracija — bendrame
// `runFileLineGuard` skelete; čia lieka tik konfigūracija ir stop režimo tęsiniai.
//
// Kodėl lint/typecheck bėga TIK stop režime: PostToolUse hook'as vykdomas po kiekvieno rašymo,
// o pilnas lint pusiau parašytame faile beveik visada raudonas — jis blokuotų darbą jo eigoje.
// Stop yra vienintelis momentas, kai failas jau turi būti sveikas.
//
// Guard root patenka į shell komandos eilutę, tad jis PRIVALO ateiti iš
// `resolveGuardRootPaths` (domain/project/guard-roots), kur nesaugi profilio reikšmė krenta į
// numatytąją — kitaip projekto redaguojamas profilis būtų komandų injekcijos primityvas.

import path from "node:path";
import {
  LARGE_COMPONENT_LINE_LIMIT,
  backendLineRules,
  frontendLineRules,
  hasMobileDebugFlag,
  isBackendApiFile,
  isFrontendReactFile,
  isMobileFile,
  isUnauthenticatedMutatingRoute,
  mobileLineRules,
} from "../../domain/policies/index.js";
import type { GuardRootKey } from "../../domain/project/index.js";
import { runFileLineGuard, type FileLineGuardDeps } from "./file-line-guard.js";
import type { HookIo } from "./protocol.js";

export type ShellCommandResult = { code: number; stdout: string; stderr: string };

export type ScopeGuardPorts = FileLineGuardDeps["ports"] & {
  /** Išspręsti guard root keliai (profilis per resolveGuardRootPaths — jau sanitizuoti). */
  guardRoots(projectRoot: string): Promise<Record<GuardRootKey, string>>;
  /** Ar komanda pasiekiama PATH'e (`pnpm`, `npm`). */
  commandExists(command: string): Promise<boolean>;
  /** Shell komandos paleidimas projekto šaknyje. */
  runShell(command: string, projectRoot: string): Promise<ShellCommandResult>;
};

export type ScopeGuardDeps = {
  ports: ScopeGuardPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  io?: HookIo;
};

function guardDeps(deps: ScopeGuardDeps): FileLineGuardDeps {
  return {
    ports: deps.ports,
    projectRoot: deps.projectRoot,
    ...(deps.runtimeRoot === undefined ? {} : { runtimeRoot: deps.runtimeRoot }),
    ...(deps.io === undefined ? {} : { io: deps.io }),
  };
}

function logDir(deps: ScopeGuardDeps): string {
  return path.join(deps.runtimeRoot ?? path.join(path.resolve(deps.projectRoot), "vq"), "logs");
}

// ---------------------------------------------------------------------------
// backend
// ---------------------------------------------------------------------------

/** Backend guard'as visada bėga „post" režimu — jis neturi stop tęsinio (jokio lint/typecheck). */
export async function hookBackendGuard(deps: ScopeGuardDeps): Promise<number> {
  const roots = await deps.ports.guardRoots(deps.projectRoot);
  return await runFileLineGuard(guardDeps(deps), "post", {
    guardLog: "backend-guard.log",
    classify: (file) => isBackendApiFile(file, roots.backend),
    rules: [...backendLineRules],
    perFile: ({ file, content, push }) => {
      if (isUnauthenticatedMutatingRoute(file, content)) {
        push(`WARN: ${file} declares a mutating route but no auth middleware was detected`);
      }
    },
    messages: {
      skip: "Backend guard praleistas — Express backend failai nekeisti",
      blocked: "BACKEND GUARD BLOKUOTAS — Express saugumo taisyklė pažeista",
      blockedConsole: [
        "Backend guard rado blokuojanciu Express saugumo problemu.",
        "Detalės: vq/logs/backend-guard.log",
      ],
      ok: "Backend guard ✅ — blokuojančių Express problemų nerasta",
    },
  });
}

// ---------------------------------------------------------------------------
// frontend
// ---------------------------------------------------------------------------

/** `true` — lint blokavo (tuomet jis pats atsakingas už savo žurnalą ir pranešimą). */
async function frontendLintStep(deps: ScopeGuardDeps, frontendRoot: string, hooksLogPath: string): Promise<boolean> {
  const io = deps.io;
  const root = path.resolve(deps.projectRoot);
  const packageJson = await deps.ports.fs.readTextFileIfExists(path.join(root, frontendRoot, "package.json"));

  // Du vartai prieš paleidžiant: paketas turi deklaruoti `lint` IR pnpm turi egzistuoti.
  // Be jų komanda kristų dėl aplinkos, o ne dėl kodo — tai būtų klaidinantis blokas.
  if (!packageJson?.includes('"lint"') || !(await deps.ports.commandExists("pnpm"))) return false;

  await deps.ports.fs.appendTextFile(hooksLogPath, `[${stamp(deps)}] Frontend lint paleidžiamas\n`);
  const lint = await deps.ports.runShell(`pnpm --dir ${frontendRoot.replace(/\\/g, "/")} lint`, root);
  await deps.ports.fs.writeTextFile(path.join(logDir(deps), "frontend-lint.log"), `${lint.stdout}${lint.stderr}`);

  if (lint.code !== 0) {
    await deps.ports.fs.appendTextFile(
      hooksLogPath,
      `[${stamp(deps)}] FRONTEND GUARD BLOKUOTAS — frontend lint nepraėjo\n`,
    );
    io?.error("Frontend lint nepraejo po React failu pakeitimu.");
    io?.error("Detalės: vq/logs/frontend-lint.log");
    return true;
  }
  return false;
}

export async function hookFrontendGuard(deps: ScopeGuardDeps, args: string[] = []): Promise<number> {
  const roots = await deps.ports.guardRoots(deps.projectRoot);
  return await runFileLineGuard(guardDeps(deps), args[0] ?? "stop", {
    guardLog: "frontend-guard.log",
    classify: (file) => isFrontendReactFile(file, roots.frontend),
    rules: [...frontendLineRules],
    perFile: ({ file, lines, push }) => {
      if (lines.length > LARGE_COMPONENT_LINE_LIMIT) {
        push(`WARN: ${file} is ${lines.length} lines; consider splitting component logic`);
      }
    },
    stopStep: (_root, hooksLogPath) => frontendLintStep(deps, roots.frontend, hooksLogPath),
    messages: {
      skip: "Frontend guard praleistas — React frontend failai nekeisti",
      blocked: "FRONTEND GUARD BLOKUOTAS — React saugumo/tvarkos taisyklė pažeista",
      blockedConsole: [
        "Frontend guard rado blokuojanciu React pakeitimu.",
        "Detalės: vq/logs/frontend-guard.log",
      ],
      ok: "Frontend guard ✅ — blokuojančių React problemų nerasta",
    },
  });
}

// ---------------------------------------------------------------------------
// mobile
// ---------------------------------------------------------------------------

async function mobileTypecheckStep(deps: ScopeGuardDeps, mobileRoot: string, hooksLogPath: string): Promise<boolean> {
  const io = deps.io;
  const root = path.resolve(deps.projectRoot);
  const tsconfigExists = await deps.ports.fs.exists(path.join(root, mobileRoot, "tsconfig.json"));
  // Sąmoningai `npm`, ne `pnpm`: išvengiama pnpm install šalutinių efektų ir veikia Windows `.cmd`.
  if (!tsconfigExists || !(await deps.ports.commandExists("npm"))) return false;

  const tsLogPath = path.join(logDir(deps), "mobile-ts.log");
  await deps.ports.fs.appendTextFile(hooksLogPath, `[${stamp(deps)}] Mobile TypeScript tikrinimas\n`);
  const result = await deps.ports.runShell(`npm run typecheck --prefix ${mobileRoot.replace(/\\/g, "/")}`, root);
  const output = `${result.stdout}${result.stderr}`;
  await deps.ports.fs.writeTextFile(tsLogPath, output);

  if (result.code !== 0) {
    const errors = output.split(/\r?\n/).filter((line) => line.includes("error TS")).length;
    await deps.ports.fs.appendTextFile(
      hooksLogPath,
      `[${stamp(deps)}] MOBILE GUARD BLOKUOTAS -- ${errors || "?"} TypeScript klaidu mobile pakete\n`,
    );
    io?.error(`Mobile TypeScript nepraejo (${errors || "?"} klaidu). Detales: vq/logs/mobile-ts.log`);
    return true;
  }

  await deps.ports.fs.appendTextFile(hooksLogPath, `[${stamp(deps)}] Mobile TypeScript OK\n`);
  return false;
}

export async function hookMobileGuard(deps: ScopeGuardDeps, args: string[] = []): Promise<number> {
  const roots = await deps.ports.guardRoots(deps.projectRoot);
  const appJsonPath = `${roots.mobile}/app.json`;

  return await runFileLineGuard(guardDeps(deps), args[0] ?? "stop", {
    guardLog: "mobile-guard.log",
    classify: (file) => isMobileFile(file, roots.mobile),
    rules: [...mobileLineRules],
    perFile: ({ file, lines, push }) => {
      if (lines.length > LARGE_COMPONENT_LINE_LIMIT) {
        push(`WARN: ${file} is ${lines.length} lines -- consider splitting into smaller components`);
      }
    },
    // `app.json` nėra `.ts/.tsx`, tad klasifikatorius jo nepagauna — bet jo `debug: true` yra
    // produkcijos konfigo problema, dėl kurios guard'as privalo laikytis „kažkas pasikeitė".
    extraFile: async (file, fullPath, push) => {
      if (file !== appJsonPath) return false;
      const content = await deps.ports.fs.readTextFileIfExists(fullPath);
      if (content !== undefined && hasMobileDebugFlag(content)) {
        push("WARN: app.json -- debug:true detected in production build config");
      }
      return true;
    },
    stopStep: (_root, hooksLogPath) => mobileTypecheckStep(deps, roots.mobile, hooksLogPath),
    messages: {
      skip: "Mobile guard praleistas -- mobile failai nekeisti",
      blocked: "MOBILE GUARD BLOKUOTAS -- React Native saugumo taisykle pazeista",
      blockedConsole: [
        "Mobile guard rado blokuojanciu React Native pakeitimu.",
        "Detales: vq/logs/mobile-guard.log",
      ],
      ok: "Mobile guard OK -- blokuojanciu React Native problemu nerasta",
    },
  });
}

function stamp(deps: ScopeGuardDeps): string {
  return (deps.ports.now?.() ?? new Date()).toISOString();
}
