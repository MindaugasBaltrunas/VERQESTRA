// Testų fs-backed CodeIntelligenceFileSystemPort adapteris — portų kontrakto etaloninė
// elgsena (E4 produkcinis adapteris privalės elgtis taip pat). Gyvena helpers/, ne test
// faile: test failo importas iš kito test failo perregistruotų jo testus.
import { access, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { CodeIntelligenceFileSystemPort } from "../../application/code-intelligence/ports.js";

export const nodeFsTestPort: CodeIntelligenceFileSystemPort = {
  async listDirectory(absoluteDir) {
    const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }));
  },
  async readTextFile(absolutePath) {
    return readFile(absolutePath, "utf8");
  },
  async readFileBytes(absolutePath) {
    return new Uint8Array(await readFile(absolutePath));
  },
  async fileSize(absolutePath) {
    return (await stat(absolutePath)).size;
  },
  async exists(absolutePath) {
    try {
      await access(absolutePath);
      return true;
    } catch {
      return false;
    }
  },
  async writeTextFileAtomic(absolutePath, content) {
    const tmp = `${absolutePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, absolutePath);
  },
  async makeDirectory(absoluteDir) {
    await mkdir(absoluteDir, { recursive: true });
  },
};
