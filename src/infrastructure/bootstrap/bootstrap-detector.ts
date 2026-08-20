// Bootstrap tinkamumo detekcija iš disko (etalonas: AG_loop orchestrator/bootstrap/
// bootstrap-detector.ts). Įrodymus renka FS adapteris, sprendimą priima grynas
// `domain/project/bootstrap.ts`. VERQESTRA keliai: task bucket'ai lieka `AG/tasks/<bucket>`
// (paketo kontraktas), architektūros šaltiniai — `vq/architecture/source/*.mmd`.

import path from "node:path";
import {
  bootstrapCheckedBuckets,
  evaluateBootstrapEligibility,
  type BootstrapEligibility,
  type BootstrapEvidence,
} from "../../domain/project/index.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

/**
 * Absoliutūs failai su nurodytu plėtiniu kataloge, rikiuoti; `[]` kai katalogo nėra
 * (etalono core/fs `listFilesByExtension` semantika — tik failai, ne katalogai).
 */
export async function listFilesByExtension(absoluteDir: string, extension: string): Promise<string[]> {
  const names = await nodeFsAdapter.listDirectoryIfExists(absoluteDir);
  if (names === undefined) return [];
  const files: string[] = [];
  for (const name of names) {
    if (!name.endsWith(extension)) continue;
    const absolutePath = path.join(absoluteDir, name);
    const stat = await nodeFsAdapter.statPath(absolutePath);
    if (stat.kind === "file") files.push(absolutePath);
  }
  return files.sort();
}

export async function detectBootstrapEligibility(projectRoot: string): Promise<BootstrapEligibility> {
  const root = path.resolve(projectRoot);

  const bucketFileLists = await Promise.all(
    bootstrapCheckedBuckets.map((bucket) => listFilesByExtension(path.join(root, "AG", "tasks", bucket), ".md")),
  );
  const readmeContent = (await nodeFsAdapter.readTextFileIfExists(path.join(root, "README.md")))?.trim();
  const mmdSources = await listFilesByExtension(path.join(root, "vq", "architecture", "source"), ".mmd");

  const evidence: BootstrapEvidence = {
    bucketsEmpty: bucketFileLists.every((files) => files.length === 0),
    hasReadme: !!readmeContent,
    mmdSources,
  };

  return evaluateBootstrapEligibility(evidence);
}
