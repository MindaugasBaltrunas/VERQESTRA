// `restore-stable` CLI adapteris (etalonas: interfaces/cli/restore-stable/index.ts).
// Atkūrimas iš stable-ref checkpoint'o: be `--execute` komanda TIK parodo planą ir nieko
// nekeičia — destruktyvus `git reset --hard` niekada nevyksta „netyčia", vien paleidus komandą.
//
// VERQESTRA skirtumai: stable-ref gyvena vq/state/stable-ref (etalone AG/state), o git ir
// failo skaitymas ateina per portus — interfaces sluoksnis infrastructure neimportuoja.

import path from "node:path";
import { consoleCliIo, type CliIo } from "../registry.js";

/** Struktūrinis stable-ref vaizdas — infrastruktūros `StableRefResult` jį tenkina. */
export type StableRefView =
  | { status: "ok"; ref: string }
  | { status: "missing"; message: string }
  | { status: "invalid"; value: string; message: string };

export type RestoreGitResult = { code: number; stdout: string; stderr?: string };

export type RestoreStablePorts = {
  loadStableRef(absolutePath: string): Promise<StableRefView>;
  /** `git -C <projectRoot> <args>` vykdytojas. */
  runGit(args: string[], projectRoot: string): Promise<RestoreGitResult>;
};

export type RestoreStableDeps = {
  ports: RestoreStablePorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  io?: CliIo;
};

export type RestoreStableResult =
  | { status: "planned"; ref: string; command: string }
  | { status: "executed"; ref: string; command: string }
  | { status: "missing" | "invalid" | "failed"; message: string };

export async function restoreStable(deps: RestoreStableDeps, args: string[] = []): Promise<RestoreStableResult> {
  const unknown = args.filter((arg) => arg !== "--execute");
  if (unknown.length > 0) {
    return { status: "failed", message: `Unknown restore-stable option: ${unknown.join(" ")}` };
  }

  const root = path.resolve(deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");
  const stableRef = await deps.ports.loadStableRef(path.join(runtimeRoot, "state", "stable-ref"));
  if (stableRef.status !== "ok") return { status: stableRef.status, message: stableRef.message };

  const command = `git -C ${JSON.stringify(root)} reset --hard ${stableRef.ref}`;
  if (!args.includes("--execute")) return { status: "planned", ref: stableRef.ref, command };

  const result = await deps.ports.runGit(["reset", "--hard", stableRef.ref], root);
  if (result.code !== 0) {
    return { status: "failed", message: result.stderr?.trim() || result.stdout.trim() || "git reset failed" };
  }
  return { status: "executed", ref: stableRef.ref, command };
}

export async function restoreStableCommand(deps: RestoreStableDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const result = await restoreStable(deps, args);

  if (result.status === "planned") {
    io.out(`Planned recovery: ${result.command}`);
    io.out("No files changed. Re-run with --execute to apply it.");
    return 0;
  }
  if (result.status === "executed") {
    io.out(`Restored stable reference: ${result.ref}`);
    return 0;
  }

  io.error(result.message);
  return 1;
}
