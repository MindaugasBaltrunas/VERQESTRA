// SRC pjūvių šviežumo patikra tarp SURINKIMO ir DISPATCH'O.
//
// ## Kodėl to reikia
//
// `code_context.symbol_fragments[].source` yra failo turinio SNAPSHOT'as, nukirptas surinkimo
// metu ir tada patikrintas prieš kodo indeksą. Dispatch vartas (`evaluateExecutionContextGate`)
// tikrina tik artefaktų tarpusavio darną: task tekstas ↔ execution-context ↔ context-pack.
// Nė vienas iš jų nepasikeičia, kai pasikeičia PATS ŠALTINIO FAILAS.
//
// Realus kelias, o ne teorinė lenktynė: pirmas bandymas suredaguoja `src/a.ts`, stop hook'as
// commit'ina, orkestratorius perleidžia TĄ PATĮ task'ą. Task tekstas tas pats, artefaktai diske
// tie patys — vartas praleidžia, o pack'e gulintis pjūvis jau pasenęs. Renderis dar ir liepdavo
// „edit this, do not re-read the file", tad worker'is redaguotų pagal nebeegzistuojantį tekstą.
//
// ## Kodėl patikra pigi
//
// `SourceSlice.hash` yra VISO FAILO sha256 (lygus `CodeIndexFile.hash` pagal konstrukciją), ne
// pjūvio teksto. Tad patikrai užtenka perskaityti failą ir palyginti vieną hash'ą — eilučių
// pjaustyti nereikia. Skaičiuojama tik po vieną kartą kiekvienam keliui.
//
// Modulis GRYNAS: skaitymą paduoda kvietėjas (dispatch kelias), nes tik jis turi IO.

import { createHash } from "node:crypto";
import { resolveProjectPath } from "../../shared/paths.js";
import type { ContextPack } from "./context-pack-schema.js";

export type SourceSliceOrigin = {
  /** Repo-santykinis kelias, iš kurio nukirptas pjūvis. */
  file: string;
  /** Viso failo sha256, užfiksuotas SURINKIMO metu. */
  hash: string;
};

/**
 * SRC pjūvių šaltiniai, dedublikuoti pagal PORĄ (kelias, hash), o ne pagal kelią.
 *
 * Skirtumas svarbus. Normaliu atveju to paties failo pjūviai ateina iš to paties indekso įrašo,
 * tad hash'as sutampa ir pora lieka viena — kaina ta pati. Bet jei pack'e tam pačiam failui
 * užfiksuoti DU SKIRTINGI hash'ai, tai sugadintas pack'as, ir jis privalo būti atmestas.
 *
 * Anksčiau čia laimėdavo pirmas, o komentaras teigė, kad neatitikimą vis tiek pagaus palyginimas.
 * NETIESA: antrasis hash'as būdavo IŠMESTAS, tad failui sutapus su pirmuoju, sugadintas antras
 * pjūvis likdavo nepastebėtas. Laikant abi poras, konfliktas tampa pasenimu PAGAL KONSTRUKCIJĄ:
 * vienas dabartinis failo hash'as fiziškai negali sutapti su dviem skirtingais, tad bent viena
 * pora nesutaps. Atskiro „sugadinta" atvejo nereikia.
 *
 * Simboliai be `source` (REF/SIG pakopos) neturi snapshot'o ir todėl negali pasenti.
 */
export function sourceSliceOrigins(pack: ContextPack): SourceSliceOrigin[] {
  const pairs = new Map<string, SourceSliceOrigin>();
  for (const symbol of pack.code_context?.symbol_fragments ?? []) {
    const source = symbol.source;
    if (source === undefined) {
      continue;
    }
    pairs.set(`${symbol.file}\n${source.hash}`, { file: symbol.file, hash: source.hash });
  }
  return [...pairs.values()];
}

/**
 * Keliai, kurių DABARTINIS turinys nebeatitinka užfiksuoto.
 *
 * `undefined` dabartinis hash'as (failo nėra arba jis neperskaitomas) laikomas PASENUSIU, o ne
 * praleidžiamas: nežinia čia negali reikšti šviežumo — tai vartas, kurio visa prasmė yra
 * neleisti worker'iui redaguoti pagal tekstą, kurio nebėra.
 */
export function staleSourceSlicePaths(
  origins: readonly SourceSliceOrigin[],
  currentHashes: ReadonlyMap<string, string | undefined>,
): string[] {
  // Dedublikuojama IŠVESTIS, ne įvestis: konfliktuojantis failas duoda dvi neatitinkančias
  // poras, bet operatoriui tai vis tiek vienas pasenęs kelias.
  return [
    ...new Set(origins.filter((origin) => currentHashes.get(origin.file) !== origin.hash).map((origin) => origin.file)),
  ].sort();
}

/** sha256 baitų — tas pats kontraktas kaip skenerio `hashFile` ir `source-slice` skaitytuvo. */
export function hashFileBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Visas kelias vienu kvietimu: pack'as + baitų skaitytuvas → pasenusių kelių sąrašas.
 *
 * `symbol.file` ateina iš ARTEFAKTO, kurį galima sugadinti ar suklastoti, tad prieš bet kokį
 * skaitymą jis praeina leksinį projekto ribų vartą. Už ribų vedantis kelias (`../`, absoliutus)
 * laikomas PASENUSIU ir skaitytuvui NEPERDUODAMAS — pack'as, rodantis už projekto, nėra vertas
 * pasitikėjimo, o vartas neturi teisės jo net paliesti.
 *
 * Vartas čia LEKSINIS ir to nepakanka: symlink'o, gulinčio projekto viduje, jis nemato. Tai
 * skaitytuvo (adapterio) atsakomybė per `realpath` — žr. `infrastructure/fs/project-containment`.
 *
 * Skaitytuvas grąžina `undefined` nesamam, neperskaitomam ar vartą neišlaikiusiam failui.
 */
export async function staleSourceSlices(
  pack: ContextPack,
  projectRoot: string,
  readFileBytes: (repoRelativePath: string) => Promise<Uint8Array | undefined>,
): Promise<string[]> {
  const origins = sourceSliceOrigins(pack);
  if (origins.length === 0) {
    return [];
  }
  // Kiekvienas UNIKALUS failas skaitomas po vieną kartą, nors konfliktuojantis pack'as duoda
  // kelias to paties kelio poras.
  const current = new Map<string, string | undefined>();
  for (const origin of origins) {
    if (current.has(origin.file)) {
      continue;
    }
    const contained = containedRepoPath(projectRoot, origin.file);
    const content = contained === undefined ? undefined : await readFileBytes(origin.file);
    current.set(origin.file, content === undefined ? undefined : hashFileBytes(content));
  }
  return staleSourceSlicePaths(origins, current);
}

/** `undefined`, kai kelias išeina už projekto ribų arba yra absoliutus. */
function containedRepoPath(projectRoot: string, candidate: string): string | undefined {
  try {
    return resolveProjectPath(projectRoot, candidate, { allowAbsoluteInsideRoot: false }, "source slice");
  } catch {
    return undefined;
  }
}
