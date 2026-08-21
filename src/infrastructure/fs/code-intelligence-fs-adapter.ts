// CodeIntelligenceFileSystemPort reali implementacija. Atskiras objektas nuo
// nodeFsAdapter, nes abu portai deklaruoja `listDirectory` SKIRTINGOMIS formomis
// (čia — DirectoryEntry su dirent vėliavomis, ten — vardų sąrašas) ir vienas objektas
// struktūriškai negali tenkinti abiejų.
//
// ## Kodėl adapteris žino projekto šaknį
//
// Šio porto skaitomas turinys eina TIESIAI į LLM promptą ir į context cache, o dalis kelių
// ateina iš task'o Markdown teksto. Application sluoksnis kelius tikrina leksiškai
// (`resolveProjectPath`), bet leksinis vartas iš principo negali pamatyti SYMLINK'o. Vienintelė
// vieta, kur tai galima patikrinti, yra ta, kuri liečia diską — todėl adapteris yra šaknies
// apimties (root-scoped), o ne singleton'as, ir kiekvieną kelią tikrina PRIEŠ skaitymą.
//
// Patį vartą realizuoja `project-containment` (leksinė patikra + `realpath`, įskaitant giliausią
// egzistuojantį protėvį rašymo keliams). Jis IŠKELTAS iš čia sąmoningai: `context-cache-store`
// skaito per `node:fs` tiesiogiai, tad jam šio adapterio vartas negalioja, ir vienintelis būdas
// neturėti dviejų skirtingų „containment" prasmių yra viena implementacija abiem.
//
// Kaina: vienas papildomas `realpath` syscall'as skaitymo keliui (rašymui — vienas ar du,
// einant aukštyn iki esamo protėvio). Indeksavimas jau daro readdir + read + stat kiekvienam
// failui, tad tai ~25 % daugiau syscall'ų mainais į vartą, be kurio symlink'as tyliai ištraukia
// svetimą turinį į promptą arba nuveda rašymą už šaknies.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CodeIntelligenceFileSystemPort, DirectoryEntry } from "../../application/code-intelligence/ports.js";
import { nodeFsAdapter } from "./node-fs-adapter.js";
import { createProjectContainment } from "./project-containment.js";

export function createCodeIntelligenceFsAdapter(projectRoot: string): CodeIntelligenceFileSystemPort {
  const containment = createProjectContainment(projectRoot);
  const root = containment.root;
  const assertInside = (absolutePath: string): Promise<string> => containment.assertInside(absolutePath);

  return {
    async listDirectory(absoluteDir: string): Promise<DirectoryEntry[]> {
      // Šaknis pati yra teisėtas listinimo taikinys, nors `lexicallyInside` ją atmeta
      // (`relative === ""`), tad vartas taikomas tik jos vidui.
      const resolved = path.resolve(absoluteDir);
      if (resolved !== root) {
        try {
          await assertInside(resolved);
        } catch {
          // Neegzistuojantis katalogas šiame porte duoda tuščią sąrašą; už ribų esantis
          // privalo atrodyti lygiai taip pat, kad skenavimas jo net nepastebėtų.
          return [];
        }
      }
      try {
        const entries = await readdir(resolved, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        }));
      } catch {
        return [];
      }
    },

    // STAT semantika (seka symlink'us), kaip nodeFsAdapter.statKind. Bet kokia klaida —
    // `absent`: skambintojas turi praleisti kelią, o ne spėti, kad tai failas. Už projekto
    // ribų esantis kelias irgi yra `absent`: jo egzistavimas nėra informacija, kurią šis
    // portas turi teisę atskleisti.
    async statKind(absolutePath: string): Promise<"file" | "directory" | "absent"> {
      try {
        const resolved = await assertInside(absolutePath);
        const stats = await stat(resolved);
        if (stats.isFile()) return "file";
        if (stats.isDirectory()) return "directory";
        return "absent";
      } catch {
        return "absent";
      }
    },

    async readTextFile(absolutePath: string): Promise<string> {
      return await readFile(await assertInside(absolutePath), "utf8");
    },

    async readFileBytes(absolutePath: string): Promise<Uint8Array> {
      return await readFile(await assertInside(absolutePath));
    },

    async fileSize(absolutePath: string): Promise<number> {
      return (await stat(await assertInside(absolutePath))).size;
    },

    async exists(absolutePath: string): Promise<boolean> {
      try {
        await assertInside(absolutePath);
      } catch {
        return false;
      }
      return await nodeFsAdapter.exists(absolutePath);
    },

    async writeTextFileAtomic(absolutePath: string, content: string): Promise<void> {
      await nodeFsAdapter.writeTextFile(await assertInside(absolutePath), content);
    },

    async makeDirectory(absoluteDir: string): Promise<void> {
      const resolved = path.resolve(absoluteDir);
      if (resolved !== root) {
        await assertInside(resolved);
      }
      await nodeFsAdapter.makeDirectory(resolved);
    },
  };
}
