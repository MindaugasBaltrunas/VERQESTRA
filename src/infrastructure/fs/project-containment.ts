// Projekto šaknies containment — VIENA implementacija visiems infrastructure keliams, kurie
// liečia diską pagal task'o duotus kelius.
//
// Buvo iškelta iš `code-intelligence-fs-adapter` po to, kai paaiškėjo, kad `context-cache-store`
// hash'uoja failus TIESIAI per `node:fs` ir adapterio vartas jam negalioja — o tenykštis
// komentaras tvirtino priešingai. Bendras modulis tą klaidų klasę uždaro struktūriškai: kas
// nori containment, jį importuoja, o ne aprašo komentare, kad kažkas kitas jį atlieka.
//
// Du sluoksniai, ir abu būtini:
//   • leksinis — pigus, be disko, gaudo `../` ir absoliučius kelius;
//   • `realpath` — vienintelis, matantis SYMLINK'ą, gulintį projekto viduje ir rodantį į išorę.
//
// Lyginama `realpath` su `realpath`: pati projekto šaknis dažnai guli po symlink'u (macOS
// `/var` → `/private/var`, Windows junction'ai), tad palyginimas su neišspręsta šaknimi atmestų
// teisėtus skaitymus visoje tokioje sistemoje.

import { realpath } from "node:fs/promises";
import path from "node:path";

export class PathEscapesProjectRootError extends Error {
  constructor(absolutePath: string, projectRoot: string) {
    super(`path escapes project root: ${absolutePath} is outside ${projectRoot}`);
    this.name = "PathEscapesProjectRootError";
  }
}

export function lexicallyInside(projectRoot: string, absolutePath: string): boolean {
  const relative = path.relative(projectRoot, absolutePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Giliausio EGZISTUOJANČIO protėvio `realpath`, sujungtas su likusia (dar nesukurta) uodega.
 *
 * `realpath` neegzistuojančiam keliui krenta, tad einama aukštyn, kol kuris nors protėvis
 * išsisprendžia. Uodegos segmentai yra vardai, kurių dar nėra, tad symlink'ų juose būti negali
 * ir paprastas `join` yra teisingas. Be šito rašymas į dar nesukurtą failą, kurio TĖVAS yra
 * symlink'as už ribų, prasmuktų: taikinio `realpath` kristų, ir patikra būtų praleista.
 *
 * Nepavykus išspręsti net failų sistemos šaknies (praktiškai neįmanoma) metama — tai vartas,
 * tad nežinia jame privalo baigtis atmetimu, o ne praleidimu.
 */
export async function resolveDeepestRealPath(absolutePath: string): Promise<string> {
  const tail: string[] = [];
  let current = absolutePath;
  for (;;) {
    const real = await realpath(current).catch(() => undefined);
    if (real !== undefined) {
      return tail.length === 0 ? real : path.join(real, ...tail);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`cannot resolve any existing ancestor of ${absolutePath}`);
    }
    tail.unshift(path.basename(current));
    current = parent;
  }
}

export type ProjectContainment = {
  /** Projekto šaknis, `path.resolve` forma. */
  readonly root: string;
  /** Metama, jei kelias išeina už šaknies; kitaip grąžina išspręstą kelią. */
  assertInside(absolutePath: string): Promise<string>;
  /** Netrikdanti forma: `undefined`, kai kelias išeina už šaknies. */
  containedOrUndefined(absolutePath: string): Promise<string | undefined>;
};

export function createProjectContainment(projectRoot: string): ProjectContainment {
  const root = path.resolve(projectRoot);
  // Šaknies `realpath` skaičiuojamas kartą ir tik pareikalavus: containment kuriamas ir tokiame
  // kontekste, kur šaknies dar nėra (bootstrap), o `realpath` tada mestų be reikalo.
  let realRootPromise: Promise<string> | undefined;
  const realRoot = async (): Promise<string> => {
    realRootPromise ??= realpath(root).catch(() => root);
    return await realRootPromise;
  };

  const assertInside = async (absolutePath: string): Promise<string> => {
    const resolved = path.resolve(absolutePath);
    if (!lexicallyInside(root, resolved)) {
      throw new PathEscapesProjectRootError(resolved, root);
    }
    const real = await resolveDeepestRealPath(resolved);
    if (!lexicallyInside(await realRoot(), real)) {
      throw new PathEscapesProjectRootError(real, await realRoot());
    }
    return resolved;
  };

  return {
    root,
    assertInside,
    async containedOrUndefined(absolutePath: string): Promise<string | undefined> {
      try {
        return await assertInside(absolutePath);
      } catch {
        return undefined;
      }
    },
  };
}
