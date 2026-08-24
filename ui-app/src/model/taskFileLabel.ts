/**
 * Užduoties failo vardas → tai, ką verta rodyti sąraše (2026-08-24, operatoriaus nurodymas).
 *
 * Sąrašo stulpelyje svarbūs DU dalykai: užduoties ID (pagal jį operatorius kalba su eile, CLI ir
 * žurnalais) ir pavadinimas (pagal jį atpažįsta, kas tai). Plėtinys ir kelias jame nieko neprideda
 * — jie tik stumia pavadinimą iš matomo ploto ir verčia jį kirpti.
 *
 * PILNAS vardas NEDINGSTA: jis lieka `title` atribute, tad detalė pasiekiama, o sąrašas lieka
 * įskaitomas. Tai skirtumas tarp trumpinimo ir informacijos praradimo.
 */

export type TaskFileLabel = {
  /** Skaitinis/žymėtinis prefiksas (`0042`, `0042-02`) arba `null`, kai vardas jo neturi. */
  id: string | null;
  /** Žmogui skirta dalis be plėtinio; niekada netuščia — kraštutiniu atveju tai visas vardas. */
  name: string;
};

/** `0042-perkelti-loop.md` → `0042` + `perkelti loop`; `0042-02-vaikas.md` → `0042-02` + `vaikas`. */
export function taskFileLabel(file: string): TaskFileLabel {
  // Kelias nukerpamas abiem separatoriais: `humanReview.file` ateina posix forma, o bucket'ų
  // sąrašai — jau vardais, tad viena forma nepakaktų.
  const base = file.split(/[\\/]/).pop() ?? file;
  const withoutExtension = base.replace(/\.md$/i, "");

  // ID yra numeris, po kurio gali eiti dar vienas numeris (vaiko užduotis `0042-02`). Griežtas
  // šablonas sąmoningai: „bet kas iki pirmo brūkšnelio" paverstų `readme-guard.md` ID `readme`.
  const match = /^(\d+(?:-\d+)*)(?:-(.*))?$/.exec(withoutExtension);
  if (!match) return { id: null, name: withoutExtension };

  const [, id, rest] = match;
  const name = (rest ?? "").replace(/[-_]+/g, " ").trim();
  // Vardas be aprašomosios dalies (`0042.md`) grąžina patį ID: tuščia eilutė sąraše būtų tuščia
  // eilutė, o ne trumpesnis vardas.
  return { id: id ?? null, name: name === "" ? (id ?? withoutExtension) : name };
}
