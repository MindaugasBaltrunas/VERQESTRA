// `compound-init` CLI adapteris (etalonas: interfaces/cli/compound-init/index.ts): paruošia
// compound-projekto darbo erdvę — katalogus, projekto profilį, produkto brief'ą ir
// konstituciją.
//
// Rašymas yra skip-if-exists (`--force` perrašo): pakartotinis paleidimas jau gyvame projekte
// neturi ištrinti operatoriaus redaguoto profilio ar brief'o. Todėl rezultatas skiria
// `created` / `overwritten` / `skipped` — operatorius mato, kas realiai įvyko.
//
// Profilis SEEDINAMAS iš realios detekcijos (detectProjectProfile), o ne iš fiksuoto
// typescript+pnpm spėjimo: tuščias projektas gauna tuos pačius default'us kaip anksčiau, o
// jau egzistuojantis — tai, kas realiai guli diske.

import path from "node:path";
import {
  detectProjectProfile,
  type DetectedProjectProfile,
  type ProfileDetectionPorts,
} from "../../../application/project-bootstrap/detect-profile.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type CompoundInitResult = {
  projectRoot: string;
  created: string[];
  overwritten: string[];
  skipped: string[];
};

export type WriteState = "created" | "overwritten" | "skipped";

export type CompoundInitPorts = ProfileDetectionPorts & {
  makeDirectory(absoluteDir: string): Promise<void>;
  /**
   * Įrašo tekstą TIK jei failo nėra (arba `overwrite: true`); grąžina, kas įvyko.
   * Etalono `writeTextIfMissing` semantika 1:1 — sprendimą priima adapteris, nes tik jis
   * mato failų sistemos lenktynes.
   */
  writeTextIfMissing(absolutePath: string, content: string, options: { overwrite: boolean }): Promise<WriteState>;
};

export type CompoundInitDeps = {
  ports: CompoundInitPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`) — profilis ir spec medis. */
  runtimeRoot?: string;
  io?: CliIo;
};

/**
 * Darbo erdvės katalogai. Task bucket'ai lieka `AG/tasks/*` (eilės kontraktas), o būsena,
 * supervizorius, žurnalai ir spec medis — vq runtime šaknyje.
 */
const AG_DIRS = [
  "tasks/queue",
  "tasks/active",
  "tasks/delegated",
  "tasks/done",
  "tasks/error",
  "tasks/failed",
  "tasks/human-review",
];

const RUNTIME_DIRS = ["project", "spec", "spec/changes", "spec/archive", "templates", "supervisor", "state", "logs", "research"];

// npm šeimos valdikliai dalijasi `<manager> <script>` konvencija, tad realią quality-gates
// komandą galima išvesti patikimai. Kitos ekosistemos (go, poetry, pip, composer, ...) vienos
// konvencijos neturi, tad quality_gates paliekamas operatoriui — išgalvota komanda, kurios
// projekte net nėra, būtų blogiau už tuščią lauką.
const NPM_FAMILY_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

export function parseCompoundInitArgs(args: string[]): { description: string; force: boolean } {
  return {
    description: args.filter((arg) => arg !== "--force").join(" ").trim(),
    force: args.includes("--force"),
  };
}

export function titleFromDescription(description: string): string {
  const words = description
    .replace(/[^A-Za-z0-9\s_-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ");
  return words || "VERQESTRA Project";
}

export function projectProfileTemplate(description: string, detected: DetectedProjectProfile): string {
  const language = detected.language.value ?? "typescript";
  const packageManager = detected.packageManager.value ?? "pnpm";
  const sourceRoots = detected.sourceRoots.value.length > 0 ? detected.sourceRoots.value : ["src"];

  const profile: Record<string, unknown> = {
    name: titleFromDescription(description),
    mode: "compound-project",
    language,
    package_manager: packageManager,
    stack: {},
    source_roots: sourceRoots,
    forbidden_paths: [".env", ".env.*", ".git/**", "node_modules/**", "dist/**"],
  };
  if (NPM_FAMILY_MANAGERS.has(packageManager)) {
    profile["quality_gates"] = {
      build: `${packageManager} build`,
      test: `${packageManager} test`,
    };
  }

  return `${JSON.stringify(profile, null, 2)}\n`;
}

export function productBriefTemplate(description: string): string {
  return [
    "# Product Brief",
    "",
    description,
    "",
    "## Operating Model",
    "",
    "This project is managed by VERQESTRA with spec-first planning, small queue tasks, context budgets, and deterministic local checks.",
    "",
  ].join("\n");
}

export function constitutionTemplate(): string {
  return [
    "# Constitution",
    "",
    "This project uses VERQESTRA to keep implementation scoped, reviewable, and verified by deterministic checks.",
    "",
  ].join("\n");
}

export async function compoundInit(deps: CompoundInitDeps, args: string[] = []): Promise<CompoundInitResult> {
  const parsed = parseCompoundInitArgs(args);
  if (!parsed.description) {
    throw new Error('Usage: verqestra compound-init "project description" [--force]');
  }

  const root = path.resolve(deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");

  await Promise.all([
    ...AG_DIRS.map((dir) => deps.ports.makeDirectory(path.join(root, "AG", ...dir.split("/")))),
    ...RUNTIME_DIRS.map((dir) => deps.ports.makeDirectory(path.join(runtimeRoot, ...dir.split("/")))),
  ]);

  const detected = await detectProjectProfile(deps.ports, root);
  const writes: Array<readonly [string, string]> = [
    [path.join(runtimeRoot, "project", "profile.json"), projectProfileTemplate(parsed.description, detected)],
    [path.join(runtimeRoot, "spec", "product-brief.md"), productBriefTemplate(parsed.description)],
    [path.join(runtimeRoot, "spec", "constitution.md"), constitutionTemplate()],
  ];

  const result: CompoundInitResult = { projectRoot: root, created: [], overwritten: [], skipped: [] };
  for (const [filePath, content] of writes) {
    const state = await deps.ports.writeTextIfMissing(filePath, content, { overwrite: parsed.force });
    result[state].push(path.relative(root, filePath).split(path.sep).join("/"));
  }

  return result;
}

export async function compoundInitCommand(deps: CompoundInitDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const result = await compoundInit(deps, args);
    io.out(`VERQESTRA compound workspace ready: ${result.projectRoot}`);
    io.out(`created: ${result.created.length}`);
    io.out(`overwritten: ${result.overwritten.length}`);
    io.out(`skipped: ${result.skipped.length}`);
    return 0;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
