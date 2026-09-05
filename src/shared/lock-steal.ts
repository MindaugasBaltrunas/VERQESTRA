// Kritusio proceso lock'o PERĖMIMO algoritmas — viena vieta visiems lock'ams (etalonas:
// AG_loop core/lock-steal.ts, task 0064).
//
// Kodėl `shared`, o ne prie vieno iš vartotojų: tą patį algoritmą naudoja ledger'io lock'as
// (interfaces/hooks) ir loop task-state lock'as (VQ-504). Modulis neturi JOKIŲ projekto
// importų ir — skirtingai nei etalone — nė vieno `node:` importo: `stat` čia atėjo parametru
// (`statMtimeMs`), tad tas pats kodas galioja bet kuriai FS realizacijai ir testas gali
// įrodyti stale ribą be laikrodžio laukimo.
//
// Algoritmas (etalono 0058 pataisa, kurią abi vietos turėjo atskirai):
//
//   `stat -> rm` yra TOCTOU: tarp patikros ir trynimo lock'ą gali teisėtai perimti NAUJAS
//   savininkas, o mes ištrintume jau JO lock'ą — tada įėjimą gautų dar vienas laukėjas ir du
//   procesai vienu metu darytų tą pačią kritinę sekciją. Be to `rm` „laimėdavo" VISI stale'ą
//   pamatę laukėjai vienu metu.
//
//   Todėl perėmimas yra `rename` į PRIVATŲ kelią: jį laimi lygiai VIENAS procesas (visi kiti
//   gauna ENOENT). Po perėmimo tikrinama nuosavybė — jei perėmėme ne tą tapatybę, kurią
//   matėme kaip stale, ir originali vieta tebėra laisva, lock'as GRĄŽINAMAS, o ne sunaikinamas.
//
// Viskas, kuo realizacijos skiriasi, ateina parametrais: lock'as gali būti failas arba
// katalogas, tapatybė — JSON su `lock_id` arba žalias tekstas, `rename` — su win32 contention
// retry arba be jo, `remove` — rekursinis arba ne.

export type StealStaleLockOptions<TIdentity> = {
  /** Perimamo lock'o kelias (failas arba katalogas). */
  lockPath: string;
  /** Lock'o mtime ms, arba `undefined` kai jo nebėra. NIEKADA nemeta. */
  statMtimeMs: (lockPath: string) => Promise<number | undefined>;
  /**
   * Privatus kelias, į kurį lock'as pervadinamas. THUNK, o ne reikšmė, nes token'o
   * generatorius gali turėti šalutinį efektą (sekos didinimas) — jis privalo suveikti TIK
   * tada, kai iki perėmimo realiai prieinama.
   */
  createStealPath: () => string;
  /** Lock'o savininko tapatybė. NIEKADA nemeta: neįskaitomas lock'as = `undefined`. */
  readIdentity: (lockPath: string) => Promise<TIdentity | undefined>;
  /**
   * Ar lock'as laikomas kritusio proceso palikimu.
   *
   * Tapatybė perskaitoma PRIEŠ šį kvietimą, nes jai gali prireikti paties lock'o turinio
   * (`created_at`). Vartotojas, kuris tapatybę skaitė TIK po stale patikros, tą patį ankstyvą
   * `return` išlaiko grąžindamas `false` neperskaitytai tapatybei (`identity === undefined`).
   */
  isStale: (identity: TIdentity | undefined, mtimeMs: number) => boolean;
  /**
   * Ar perėmėme JAU KITO savininko lock'ą (tada jį reikia grąžinti, o ne sunaikinti).
   *
   * KONTRAKTAS: **nepatvirtinta nuosavybė = svetima.** Realizacija privalo grąžinti `true`, kai
   * `stolen` turi tapatybę, o `observed` jos neturi. Priešingu atveju atsiveria langas, kuriame
   * naikinamas gyvas lock'as: `observed` lieka `undefined`, kai savininkas dar nespėjo įsirašyti
   * arba jo įrašas laikinai neįskaitomas, o `isStale` tada sprendžia pagal katalogo mtime. Tarp
   * `readIdentity` ir `rename` lock'ą teisėtai perima kitas, dar kitas sukuria savo katalogą — ir
   * `rename` paima JAU jo tapatybę. Sąlyga „observed !== undefined && …" tokį perėmimą palaiko
   * savu, `remove` sunaikina svetimą lock'ą, o į kritinę sekciją įeina du procesai.
   *
   * Kai abi tapatybės neapibrėžtos (katalogas be savininko įrašo abu kartus), `false` yra
   * teisingas atsakymas: tai pakibęs lock'as, kurio niekas nebeturi, ir jį reikia išvalyti.
   */
  isForeign: (observed: TIdentity | undefined, stolen: TIdentity | undefined) => boolean;
  /** `rename` — su arba be platformos contention retry (žr. kvietėją). */
  rename: (from: string, to: string) => Promise<void>;
  /** Ar kelias vis dar užimtas. */
  exists: (path: string) => Promise<boolean>;
  /** Perimto lock'o išvalymas. Privalo NEMESTI — kvietėjas pats nurauna klaidas. */
  remove: (path: string) => Promise<void>;
};

/**
 * Perima lock'ą, likusį po kritusio proceso. Niekada nemeta ir niekada nesunaikina lock'o,
 * kurio nuosavybė nepatvirtinta.
 */
export async function stealStaleLock<TIdentity>(options: StealStaleLockOptions<TIdentity>): Promise<void> {
  const observedMtimeMs = await options.statMtimeMs(options.lockPath);
  if (observedMtimeMs === undefined) {
    // Lock'o nebėra arba `stat` nepavyko — kitas retry ciklas bandys iš naujo.
    return;
  }
  const observed = await options.readIdentity(options.lockPath);
  if (!options.isStale(observed, observedMtimeMs)) {
    return;
  }

  const stealPath = options.createStealPath();
  try {
    await options.rename(options.lockPath, stealPath);
  } catch {
    // Lock'o nebėra arba jį jau perėmė kitas laukėjas — kitas ciklas bandys iš naujo.
    return;
  }

  const stolen = await options.readIdentity(stealPath);
  if (options.isForeign(observed, stolen) && !(await options.exists(options.lockPath))) {
    try {
      // Perėmėme JAU NAUJĄ savininką: jo lock'as grąžinamas, o mes liekame laukti.
      await options.rename(stealPath, options.lockPath);
      return;
    } catch {
      // Grąžinti nepavyko (vietą jau užėmė kitas) — krentame į išvalymą; praradimą naujasis
      // savininkas pamato pats atlaisvindamas savo lock'ą.
    }
  }
  await options.remove(stealPath);
}
