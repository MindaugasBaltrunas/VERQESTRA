// CodeIntelligenceFileSystemPort reali implementacija. Atskiras objektas nuo
// nodeFsAdapter, nes abu portai deklaruoja `listDirectory` SKIRTINGOMIS formomis
// (čia — DirectoryEntry su dirent vėliavomis, ten — vardų sąrašas) ir vienas objektas
// struktūriškai negali tenkinti abiejų.

import { readdir, readFile, stat } from "node:fs/promises";
import type { CodeIntelligenceFileSystemPort, DirectoryEntry } from "../../application/code-intelligence/ports.js";
import { nodeFsAdapter } from "./node-fs-adapter.js";

export const codeIntelligenceFsAdapter: CodeIntelligenceFileSystemPort = {
  async listDirectory(absoluteDir: string): Promise<DirectoryEntry[]> {
    try {
      const entries = await readdir(absoluteDir, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    } catch {
      return [];
    }
  },

  async readTextFile(absolutePath: string): Promise<string> {
    return await readFile(absolutePath, "utf8");
  },

  async readFileBytes(absolutePath: string): Promise<Uint8Array> {
    return await readFile(absolutePath);
  },

  async fileSize(absolutePath: string): Promise<number> {
    return (await stat(absolutePath)).size;
  },

  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  writeTextFileAtomic: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
};
