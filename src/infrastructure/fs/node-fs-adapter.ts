// VIENAS Node FS adapteris VISIEMS E3 klasterių fs portams (E4 WBR VQ-401): klasterių
// portai (ContextPackFileSystemPort, BenchmarkFsPort, LearningFsPort,
// CompressionQualityFsPort, TaskPlanningFsPort, PolicyProposalsFsPort,
// SchedulingFileSystemPort skaitymo pusė, ReleaseCheckFsPort, ConvergePorts /
// BacklogAuditPorts / ReadinessPorts fs pusės, TaskGeneratePorts.fs,
// PolicyProposalServicePorts.fs) yra struktūriniai šio objekto poaibiai.
// Elgesio etalonas: AG_loop core/fs.ts.
//
// Semantikos sprendimai, užfiksuoti čia (ne kvietėjuose):
//  - readTextFileIfExists — RAW tekstas be trim (E3 portų kontraktas; etalono
//    readTextIfExistsRaw semantika: nesamas failas arba ne-failas → undefined);
//  - writeTextFile — VISADA atominis (unikalus tmp + rename su win32 retry + tėvinio
//    katalogo mkdir): etalono writeTextAtomic, vienintelė atominio rašymo realizacija;
//  - appendTextFile — mkdir tėvą + append (etalono appendLog);
//  - statPath — LSTAT semantika: symlink'as yra `other`, ne jo taikinys (BenchmarkFsPort
//    gynybinis kontraktas);
//  - statKind — STAT semantika (seka symlink'us): readiness reikalavimams symlink'intas
//    realus katalogas YRA katalogas (etalono missingPaths elgesys);
//  - list* — nesamas katalogas yra tuščias sąrašas (nebuvimas — atsakymas, ne klaida).

import { randomBytes } from "node:crypto";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { withWin32RenameRetry } from "./fs-retry.js";

export type NodeStatPathResult = { kind: "file" | "directory" | "other" | "absent"; size: number };

export const nodeFsAdapter = {
  async exists(absolutePath: string): Promise<boolean> {
    try {
      await access(absolutePath);
      return true;
    } catch {
      return false;
    }
  },

  async readTextFileIfExists(absolutePath: string): Promise<string | undefined> {
    try {
      const stats = await stat(absolutePath);
      if (!stats.isFile()) return undefined;
    } catch {
      return undefined;
    }
    return await readFile(absolutePath, "utf8");
  },

  async readTextFile(absolutePath: string): Promise<string> {
    return await readFile(absolutePath, "utf8");
  },

  async readFileBytes(absolutePath: string): Promise<Uint8Array> {
    return await readFile(absolutePath);
  },

  async appendTextFile(absolutePath: string, text: string): Promise<void> {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await appendFile(absolutePath, text, "utf8");
  },

  async writeTextFile(absolutePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    // Tarpinis failas turi UNIKALŲ vardą: fiksuotas `.tmp` atomiškumą garantuotų tik
    // viename procese — du rašytojai į tą patį kelią paliktų diske sugadintą įrašą
    // (etalono 2026-08-06 audito ui-loop.pid pamoka).
    const tmp = `${absolutePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, content, "utf8");
      await withWin32RenameRetry(() => rename(tmp, absolutePath));
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  },

  async makeDirectory(absoluteDir: string): Promise<void> {
    await mkdir(absoluteDir, { recursive: true });
  },

  async writeFileExclusive(absolutePath: string, content: string): Promise<"created" | "exists"> {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    try {
      await writeFile(absolutePath, content, { encoding: "utf8", flag: "wx" });
      return "created";
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        return "exists";
      }
      throw error;
    }
  },

  async listDirectory(absoluteDir: string): Promise<string[]> {
    try {
      return (await readdir(absoluteDir)).sort();
    } catch {
      return [];
    }
  },

  async listSubdirectories(absoluteDir: string): Promise<string[]> {
    try {
      const entries = await readdir(absoluteDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch {
      return [];
    }
  },

  async listFiles(absoluteDir: string): Promise<string[]> {
    try {
      const entries = await readdir(absoluteDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    } catch {
      return [];
    }
  },

  /** Absoliutūs `.md` keliai, rūšiuoti (BootstrapSpecPorts.listMarkdownFiles kontraktas). */
  async listMarkdownFiles(absoluteDir: string): Promise<string[]> {
    try {
      const entries = await readdir(absoluteDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => path.join(absoluteDir, entry.name))
        .sort();
    } catch {
      return [];
    }
  },

  async statPath(absolutePath: string): Promise<NodeStatPathResult> {
    try {
      const stats = await lstat(absolutePath);
      if (stats.isFile()) return { kind: "file", size: stats.size };
      if (stats.isDirectory()) return { kind: "directory", size: 0 };
      return { kind: "other", size: 0 };
    } catch {
      return { kind: "absent", size: 0 };
    }
  },

  async statKind(absolutePath: string): Promise<"file" | "directory" | "absent"> {
    try {
      const stats = await stat(absolutePath);
      if (stats.isFile()) return "file";
      if (stats.isDirectory()) return "directory";
      return "absent";
    } catch {
      return "absent";
    }
  },

  async fileMtimeMs(absolutePath: string): Promise<number | undefined> {
    try {
      return (await stat(absolutePath)).mtimeMs;
    } catch {
      return undefined;
    }
  },

  async newestMtime(absolutePaths: string[]): Promise<number | undefined> {
    const times = await Promise.all(absolutePaths.map((file) => nodeFsAdapter.fileMtimeMs(file)));
    const present = times.filter((time): time is number => time !== undefined);
    return present.length > 0 ? Math.max(...present) : undefined;
  },

  /** Naujausias mtime visame katalogo medyje; `undefined`, kai katalogo nėra/tuščias. */
  async newestMtimeInDir(absoluteDir: string): Promise<number | undefined> {
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    let newest: number | undefined;
    for (const entry of entries) {
      const child = path.join(absoluteDir, entry.name);
      const time = entry.isDirectory()
        ? await nodeFsAdapter.newestMtimeInDir(child)
        : await nodeFsAdapter.fileMtimeMs(child);
      if (time !== undefined && (newest === undefined || time > newest)) newest = time;
    }
    return newest;
  },

  async removeIfExists(absolutePath: string): Promise<void> {
    await rm(absolutePath, { force: true }).catch(() => undefined);
  },

  // --- SchedulingFileSystemPort pusė (VQ-303 kontraktas; store logika — VQ-403) ---

  /** Katalogo įrašų vardai arba `undefined`, kai katalogo nėra (skirtinga nuo listDirectory `[]`). */
  async listDirectoryIfExists(absoluteDir: string): Promise<string[] | undefined> {
    try {
      return (await readdir(absoluteDir)).sort();
    } catch {
      return undefined;
    }
  },

  /** Atominis įrašymas — tas pats kelias kaip writeTextFile (portas vardija semantiką aiškiai). */
  async writeTextFileAtomic(absolutePath: string, content: string): Promise<void> {
    await nodeFsAdapter.writeTextFile(absolutePath, content);
  },

  /** Atominis „sukurk arba pasakyk, kad yra" mutex primityvas (`mkdir` be `recursive`). */
  async createLockDirectory(absoluteDir: string): Promise<"created" | "exists"> {
    try {
      await mkdir(absoluteDir);
      return "created";
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        return "exists";
      }
      throw error;
    }
  },

  /** Best-effort pašalinimas; klaidas nutyli KVIETĖJAS, ne portas. */
  async removeDirectory(absoluteDir: string): Promise<void> {
    await rm(absoluteDir, { recursive: true, force: true });
  },

  /** Katalogo mtime (ms) stale-lock patikrai; `undefined`, kai katalogo nebėra. */
  async directoryModifiedAtMs(absoluteDir: string): Promise<number | undefined> {
    return await nodeFsAdapter.fileMtimeMs(absoluteDir);
  },
};

export type NodeFsAdapter = typeof nodeFsAdapter;
