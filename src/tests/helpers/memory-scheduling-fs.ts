// Atmintyje laikomas `SchedulingFileSystemPort` testams.
//
// Buvo trys beveik pažodinės kopijos (scheduling-stores, scheduling-wave-provisioning,
// scheduling-provision-lease-release). 2026-08-24, prijungiant nuosavybės tokenus, paaiškėjo,
// kodėl tai svarbu: visoms trims `removeDirectory` trynė TIK katalogo įrašą, o ne jame gulinčius
// failus. Su nauju protokolu tai reikštų, kad `owner.json` pergyvena atlaisvinimą, kitas ėmėjas
// perskaito svetimą `lock_id` ir NIEKADA neįeina. Fake'as, silpnesnis už tikrą adapterį, testą
// paverčia melu — tad čia jis toks pat rekursinis, koks yra `rm(recursive: true)`.

import type { SchedulingFileSystemPort } from "../../application/scheduling/index.js";

export type MemorySchedulingFs = {
  files: Map<string, string>;
  dirs: Set<string>;
  port: SchedulingFileSystemPort;
};

const norm = (value: string): string => value.replace(/\\/g, "/");

/**
 * @param nowMs Katalogo mtime, kurį grąžina `directoryModifiedAtMs`. Fiksuotas, kad stale ribą
 *   būtų galima įrodyti be tikro laukimo — laikas testuose yra įėjimas, ne aplinkybė.
 */
export function memorySchedulingFs(nowMs: number): MemorySchedulingFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  /** Visi po šiuo keliu gulintys failai — `rm -r` prasme. */
  const filesUnder = (dir: string): string[] => {
    const prefix = `${dir}/`;
    return [...files.keys()].filter((key) => key.startsWith(prefix));
  };

  const port: SchedulingFileSystemPort = {
    readTextFileIfExists: (p) => Promise.resolve(files.get(norm(p))),
    listDirectoryIfExists: (dir) => {
      const prefix = `${norm(dir)}/`;
      const names = [...files.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .filter((name) => !name.includes("/"));
      if (names.length === 0 && !dirs.has(norm(dir))) return Promise.resolve(undefined);
      return Promise.resolve(names);
    },
    writeTextFileAtomic: (p, content) => {
      files.set(norm(p), content);
      return Promise.resolve();
    },
    makeDirectory: (dir) => {
      dirs.add(norm(dir));
      return Promise.resolve();
    },
    exists: (p) =>
      Promise.resolve(files.has(norm(p)) || dirs.has(norm(p)) || filesUnder(norm(p)).length > 0),
    createLockDirectory: (dir) => {
      const key = norm(dir);
      if (dirs.has(key)) return Promise.resolve("exists");
      dirs.add(key);
      return Promise.resolve("created");
    },
    removeDirectory: (dir) => {
      const key = norm(dir);
      dirs.delete(key);
      // Rekursinis — kaip `rm(recursive: true)` tikrame adapteryje.
      for (const file of filesUnder(key)) files.delete(file);
      return Promise.resolve();
    },
    directoryModifiedAtMs: (dir) => Promise.resolve(dirs.has(norm(dir)) ? nowMs : undefined),
    renamePath: (from, to) => {
      const source = norm(from);
      const target = norm(to);
      if (dirs.delete(source)) dirs.add(target);
      for (const file of filesUnder(source)) {
        const content = files.get(file);
        files.delete(file);
        if (content !== undefined) files.set(`${target}${file.slice(source.length)}`, content);
      }
      const direct = files.get(source);
      if (direct !== undefined) {
        files.delete(source);
        files.set(target, direct);
      }
      return Promise.resolve();
    },
  };

  return { files, dirs, port };
}
