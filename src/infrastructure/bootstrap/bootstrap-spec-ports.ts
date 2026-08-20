// Realios `BootstrapSpecPorts` implementacijos (application/project-bootstrap/generate.ts
// porto kontraktas). Kiekvienas laukas — jau egzistuojantis šio klasterio modulis; čia tik
// sujungimas, jokios naujos logikos: README intencija (readme-intent), idempotentiškas grafo
// refresh'as (bootstrap-architecture), grafo skaitymas (architecture-graph-store), headless
// LLM generatorius (openspec-autogen) ir change katalogo `.md` sąrašas.

import path from "node:path";
import type { BootstrapSpecPorts } from "../../application/project-bootstrap/generate.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { loadReadmeProductIntent } from "./readme-intent.js";
import { bootstrapArchitectureFromSource } from "./bootstrap-architecture.js";
import { readGraph } from "./architecture-graph-store.js";
import { generateOpenSpecChange, type GenerateOpenSpecChangeDeps } from "./openspec-autogen.js";

/**
 * Absoliutūs `.md` failai kataloge, rikiuoti; `[]` kai katalogo nėra (etalono
 * listMarkdownFilePaths semantika — bootstrap generavimo rezultato patikrai).
 */
export async function listMarkdownFiles(absoluteDir: string): Promise<string[]> {
  const names = await nodeFsAdapter.listDirectoryIfExists(absoluteDir);
  if (names === undefined) return [];
  return names
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(absoluteDir, name))
    .sort();
}

/**
 * Produkcinis `BootstrapSpecPorts` rinkinys. `generatorDeps` leidžia kompozicijos šakniai
 * (ar testui) perrašyti headless runner'į / runtime šaknį nekeičiant likusių tiekėjų.
 */
export function createBootstrapSpecPorts(generatorDeps: GenerateOpenSpecChangeDeps = {}): BootstrapSpecPorts {
  return {
    loadReadmeProductIntent,
    async refreshArchitectureFromSource(projectRoot: string): Promise<void> {
      await bootstrapArchitectureFromSource(projectRoot);
    },
    readArchitectureGraph: readGraph,
    generateChange: (taskText, taskId, agRoot, model) =>
      generateOpenSpecChange(taskText, taskId, agRoot, model, generatorDeps),
    listMarkdownFiles,
  };
}
