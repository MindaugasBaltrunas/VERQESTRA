// Hook'ų portų surišimas su Node adapteriais (VQ-502 palikimas: moduliai buvo vietoje, wiring'as
// laukė kompozicijos).
//
// Hook'as vykdomas Claude Code proceso, ne operatoriaus: jo darbinis katalogas nenuspėjamas, o
// vienintelis įėjimas yra stdin. Todėl čia surišami trys dalykai, kurių interfaces sluoksnis
// pasiimti negali: stdin skaitymas, git zondas ir konfigo skaitymas.

import { spawn } from "node:child_process";
import type { ContextCompressionConfig } from "../domain/policies/compression/features.js";
import { loadContextCompressionConfig } from "../application/context-pack/effective-compression-policy.js";
import type { PostHookPorts, PostHookProcessResult } from "../interfaces/hooks/post-hook-context.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";

/**
 * Visas stdin iki EOF.
 *
 * Terminas yra BŪTINAS: hook'as, kurio stdin niekada neužsidaro (klaidingai sukonfigūruotas
 * įėjimas, rankinis paleidimas be payload'o), kitaip kabintų Claude įrankio kvietimą neribotai.
 * Pasibaigus terminui grąžinamas tuščias tekstas — parsinimo sluoksnis tai jau traktuoja
 * fail-closed (PreToolUse) arba no-op (PostToolUse) kryptimi.
 */
export function readStdin(timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };

    const deadline = setTimeout(() => finish(""), timeoutMs);
    deadline.unref?.();

    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => finish(""));
  });
}

/**
 * Vieno kelio `git status`. Kelias eina į ARGUMENTUS, ne į shell eilutę — laisvos formos vardas
 * niekada netampa komandos dalimi.
 *
 * `--ignored=matching` yra būtinas, o ne kosmetinis: be jo gitignore'intas kelias duoda tuščią
 * išvedimą su kodu 0 — lygiai kaip tracked-ir-švarus failas, ir naujas failas tokiame kataloge
 * virstų „modified" spėjimu.
 */
export function gitStatusForPath(projectRoot: string, relativePath: string): Promise<PostHookProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["-C", projectRoot, "status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--", relativePath],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    // Nepaleistas git (nėra binaro, nėra repo) reiškia „nežinau", ne klaidą: klasifikacija tokiu
    // atveju krenta į `unknown`, o hook'as niekada neblokuoja dėl savo telemetrijos.
    child.on("error", () => resolve({ code: 1, stdout: "" }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

/** PostToolUse hook'ų portai: fs, stdin, kompresijos konfigas, git zondas ir aplinka. */
export function postHookPorts(): PostHookPorts {
  return {
    fs: {
      exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
      makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
      readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
      readContendedTextFileIfExists: (absolutePath) => nodeFsAdapter.readContendedTextFileIfExists(absolutePath),
      writeTextFile: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
      writeFileExclusive: (absolutePath, content) => nodeFsAdapter.writeFileExclusive(absolutePath, content),
      renamePath: (fromPath, toPath) => nodeFsAdapter.renamePath(fromPath, toPath),
      removeFile: (absolutePath) => nodeFsAdapter.removeFile(absolutePath),
      fileMtimeMs: (absolutePath) => nodeFsAdapter.fileMtimeMs(absolutePath),
      appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
    },
    stdin: { readStdin: () => readStdin() },
    // Portas prašo tik konfigo, bet skaitytojas deklaruoja platesnį `ContextPackFileSystemPort`.
    // Adapteris tenkina jį struktūriškai, tad siaurinimo eilutės nereikia.
    loadCompressionConfig: (runtimeRoot): Promise<ContextCompressionConfig | undefined> =>
      loadContextCompressionConfig(nodeFsAdapter, runtimeRoot).catch(() => undefined),
    gitStatusForPath: (projectRoot, relativePath) => gitStatusForPath(projectRoot, relativePath),
    env: (name) => process.env[name],
  };
}
