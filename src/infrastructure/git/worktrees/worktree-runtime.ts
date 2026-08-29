// Izoliuotos darbo kopijos RUNTIME bootstrap'as (etalonas: AG_loop
// orchestrator/loop/slot-task-runner.ts `ensureWorktreeRuntime` + `ensureProductDependencies`).
//
// `git worktree add` duoda TIK versijuotus failus, o visa, kas reikalinga vykdymui — `dist`,
// `node_modules`, lokalus konfigas — yra gitignored. Be šio žingsnio vaikas kopijoje nulūžtų dar
// prieš pirmą darbą.
//
// Dvi dalys, viena po kitos:
//   1. RUNTIME: nuosava `dist` KOPIJA, `node_modules` junction'as, konfigo failų kopijos;
//   2. PRODUKTO priklausomybės: kiekvienos aptiktos paketo šaknies `node_modules` — junction'as,
//      kai lockfile hash'ai sutampa, kitu atveju lockfile-neutralus install'as kopijos viduje.
//
// Kodėl `dist` yra KOPIJA, o ne junction: vaiko kokybės vartai kopijoje paleidžia build'ą, o
// junction'as rašymus praleistų KIAURAI į pirminį `dist` — lenktynė su gretimu slot'u. Kopija
// duoda vaikui NUOSAVĄ `dist`, o `node_modules` lieka junction'u, nes jo niekas nerašo, o pilna
// kopija būtų šimtai MB kiekvienam slot'ui.
//
// NUKRYPIMAS nuo etalono (parametrizacija): keliai (`dist`, `node_modules`, konfigas) ateina per
// `WorktreeRuntimeLayout`, o ne yra įrašyti kaip `AG/orchestrator/...` konstantos. Etalone jie
// buvo teisingi lygiai vienoje repozitorijos struktūroje.

import { copyFile, cp, lstat, mkdir, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BUILD_STAMP } from "../../process/dist-freshness.js";
import { discoverProductRoots, resolveTreePath } from "./workspace-roots.js";

/**
 * Kopijos-lokalus (gitignored) žymuo: lockfile hash'as, kuriam install'as jau sėkmingai įvyko.
 *
 * Junction'ams žymens nereikia — jų idempotencija yra pats junction'o egzistavimas. Install'as
 * palieka TIKRĄ katalogą, kurio vien iš egzistavimo neatskirsi nuo pasenusio ar dalinio.
 */
const PRODUCT_DEPS_MARKER = ".vq/worktree-product-deps.hash";

/** Install'o stabdiklis: pakabintas paketų valdyklės procesas užrakintų visą slot'ą. */
export const PRODUCT_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Lockfile → paketų valdyklė ir DETERMINISTINĖ install komanda, nuo specifiškiausio.
 *
 * Visos komandos lockfile-neutralios (`--frozen-lockfile` / `ci`): install'as NEGALI mutuoti
 * lockfile'o, nes kopija taptų nešvari ir vaiko švaraus medžio vartai kristų dėl paties bootstrap'o.
 */
export const PRODUCT_LOCKFILES: readonly { lockfile: string; packageManager: string; installArgs: string[] }[] = [
  { lockfile: "pnpm-lock.yaml", packageManager: "pnpm", installArgs: ["install", "--frozen-lockfile"] },
  { lockfile: "package-lock.json", packageManager: "npm", installArgs: ["ci"] },
  { lockfile: "yarn.lock", packageManager: "yarn", installArgs: ["install", "--frozen-lockfile"] },
  { lockfile: "bun.lock", packageManager: "bun", installArgs: ["install", "--frozen-lockfile"] },
  { lockfile: "bun.lockb", packageManager: "bun", installArgs: ["install", "--frozen-lockfile"] },
];

export type ProductInstallRequest = {
  /** Kopijos šaknis. Install'as VISADA vykdomas joje — pirminis medis lieka tik skaitymo šaltinis. */
  cwd: string;
  /** Šaknys, dėl kurių install'o prireikė (diagnostikai). */
  roots: string[];
  packageManager: string;
  command: string;
  args: string[];
};

export type ProductInstallRunner = (request: ProductInstallRequest) => Promise<number>;

export type WorktreeRuntimeLayout = {
  /** Katalogas, kurio KOPIJA keliauja į darbo kopiją (paprastai `dist`). */
  distDir: string;
  /** Katalogas, junction'inamas į pirminį medį (paprastai `node_modules`). */
  nodeModulesDir: string;
  /** Gitignored konfigo failai, kopijuojami dėl pariteto su pirminiu medžiu. */
  configFiles: readonly string[];
  /**
   * Gitignored konfigo KATALOGAI, kopijuojami ištisai (pvz. `vq/config`).
   *
   * Benchmark 2026-08-22 ir GeoGravity 2026-08-28 pamoka ta pati: kopijuojant po vieną failą
   * kiekvienas praleistas konfigas (`tool-budget.json`, policy failai) atrandamas tik kitame
   * MOKAMAME vaiko paleidime kaip beveidis lūžis. Aprūpinama visa aibė, ne po failą.
   */
  configDirs?: readonly string[];
  /** Junction'ai, kurių nebuvimas pirminiame medyje NĖRA klaida (pvz. dar nebuild'inta UI). */
  optionalJunctions: readonly string[];
};

export type EnsureWorktreeRuntimeInput = {
  projectRoot: string;
  worktreeAbs: string;
  layout: WorktreeRuntimeLayout;
  log?: (message: string) => Promise<void>;
  /** Install'o paleidėjas. Testai jį paduoda, tad testų rinkinys niekada nedaro tikro install'o. */
  runProductInstall?: ProductInstallRunner;
};

/** `lstat`, ne `stat`: jau sukurtas, bet (dar) neveikiantis junction'as irgi yra „yra". */
async function lstatOrUndefined(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch {
    return undefined;
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Absoliutus pnpm kelias iš TĖVO proceso aplinkos (`npm_execpath` — skriptas, kuriuo pats
 * orchestratorius buvo paleistas), o ne plika PATH paieška.
 *
 * GeoGravity 2026-08-29: 20/44 w2 slot'ų žuvo su „exit 127" — tai reiškia „komanda nerasta"
 * vaiko aplinkoje, ne install'o klaidą. `npm_execpath` yra vienintelis DETERMINISTINIS pnpm
 * vietos šaltinis, nes jis paveldimas iš proceso, kuris jau sėkmingai paleido patį loop'ą.
 *
 * Jei aplinkoje šios žymos nėra arba ji nesusijusi su pnpm (kitas paketų valdiklis paleido
 * orchestratorių), grįžtama prie senos plikos PATH paieškos — elgesys nesikeičia ten, kur jis
 * jau veikė.
 */
async function resolvePnpmExecutable(): Promise<{ command: string; args: string[] }> {
  const execpath = process.env["npm_execpath"];
  if (typeof execpath !== "string" || execpath.length === 0 || !path.basename(execpath).toLowerCase().includes("pnpm")) {
    return { command: "pnpm", args: [] };
  }
  if (!(await pathEntryExists(execpath))) {
    throw new Error(`pnpm nerastas: ${execpath}`);
  }
  // `npm_execpath` paprastai rodo į pnpm CLI SKRIPTĄ (.cjs/.js/.mjs), ne į vykdomąjį failą — jam
  // paleisti reikia to paties node interpretatoriaus, kuriuo jau veikia šis procesas.
  if (/\.(c|m)?js$/i.test(execpath)) {
    return { command: process.execPath, args: [execpath] };
  }
  return { command: execpath, args: [] };
}

async function pathEntryExists(target: string): Promise<boolean> {
  return (await lstatOrUndefined(target)) !== undefined;
}

async function readFileOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

async function hashFileOrUndefined(target: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(target)).digest("hex");
  } catch {
    return undefined;
  }
}

/** Pirmas pirminiame medyje egzistuojantis žinomas lockfile. */
async function firstExistingLockfile(projectRoot: string): Promise<(typeof PRODUCT_LOCKFILES)[number] | undefined> {
  for (const candidate of PRODUCT_LOCKFILES) {
    if (await pathEntryExists(path.join(projectRoot, candidate.lockfile))) return candidate;
  }
  return undefined;
}

/**
 * Produkto priklausomybių paruošimas kopijoje.
 *
 *   - lockfile hash'ai SUTAMPA → priklausomybių grafas tas pats, tad kiekvienos šaknies
 *     `node_modules` yra JUNCTION į pirminį medį: nulis I/O ir tas pats read-only invariantas;
 *   - hash'ai SKIRIASI (šaka pakeitė deps) arba pirminio `node_modules` nėra → junction'as
 *     MELUOTŲ, todėl kopijos viduje paleidžiamas vienas lockfile-neutralus install'as.
 *
 * Idempotencija: galiojantis junction'as paliekamas; install'as nekartojamas, kol žymuo sutampa su
 * dabartiniu lockfile hash'u. Pasenęs junction'as prieš install'ą pašalinamas — kitaip vaikas
 * dirbtų su svetimomis pirminio medžio deps.
 *
 * Ne-JS taikiniai (nėra žinomo lockfile) — švarus praleidimas su žurnalo eilute, ne klaida.
 */
async function ensureProductDependencies(input: EnsureWorktreeRuntimeInput): Promise<void> {
  const { projectRoot, worktreeAbs, log } = input;
  const detected = await firstExistingLockfile(projectRoot);
  if (detected === undefined) {
    await log?.("WORKTREE BOOTSTRAP: pirminiame medyje nėra žinomo lockfile — produkto deps žingsnis praleistas");
    return;
  }

  const primaryHash = await hashFileOrUndefined(path.join(projectRoot, detected.lockfile));
  const worktreeHash = await hashFileOrUndefined(path.join(worktreeAbs, detected.lockfile));
  // Kopija be lockfile'o: palyginti nėra su kuo, o vienintelis deterministinis šaltinis lieka
  // pirminis medis — junction'as teisingesnis už `--frozen-lockfile` install'ą, kuris be
  // lockfile'o iškart kristų.
  const reusable = primaryHash !== undefined && (worktreeHash === undefined || worktreeHash === primaryHash);
  const bootstrapHash = worktreeHash ?? primaryHash;

  const markerPath = resolveTreePath(worktreeAbs, PRODUCT_DEPS_MARKER);
  const markerHash = (await readFileOrUndefined(markerPath))?.trim();
  const markerValid = bootstrapHash !== undefined && markerHash === bootstrapHash;

  const roots = await discoverProductRoots({
    treeAbs: worktreeAbs,
    readFileIfExists: readFileOrUndefined,
    pathExists: pathEntryExists,
    // Runtime šaknis jau sutvarkyta junction'u dėl vaiko hook'ų — antrą kartą jos neliečiame.
    skip: [path.posix.dirname(input.layout.nodeModulesDir) === "." ? "." : path.posix.dirname(input.layout.nodeModulesDir)],
  });

  const junctioned: string[] = [];
  const staleJunctions: string[] = [];
  const needInstall: string[] = [];

  for (const root of roots) {
    const target = resolveTreePath(worktreeAbs, root, "node_modules");
    const stats = await lstatOrUndefined(target);
    if (stats?.isSymbolicLink() === true) {
      if (reusable) continue;
      staleJunctions.push(target);
      needInstall.push(root);
      continue;
    }
    if (stats !== undefined) {
      // Tikras katalogas = kopijos-lokalaus install'o rezultatas. Pasitikima TIK tada, kai žymuo
      // patvirtina, kad jis instaliuotas būtent šiam lockfile hash'ui.
      if (!markerValid) needInstall.push(root);
      continue;
    }
    const primaryTarget = resolveTreePath(projectRoot, root, "node_modules");
    if (reusable && (await pathEntryExists(primaryTarget))) {
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(primaryTarget, target, "junction");
      junctioned.push(root);
      continue;
    }
    needInstall.push(root);
  }

  if (needInstall.length === 0 || markerValid) {
    if (junctioned.length > 0) {
      await log?.(`WORKTREE BOOTSTRAP: produkto deps per junction'us (lockfile hash sutampa): ${junctioned.join(", ")}`);
    }
    return;
  }

  // Pasenę junction'ai šalinami TIK dabar — tik tada, kai jų vietoje tikrai bus install'as.
  for (const target of staleJunctions) await unlink(target);

  // Bare "pnpm" pasikliauna vaiko PATH — GeoGravity 2026-08-29 rodo, kad kopijos aplinkoje jo
  // dažnai nėra (20/44 w2 slot'ų su exit 127). Kiti valdikliai (npm/yarn/bun) šio defekto
  // neįrodė, tad jų kelias lieka nepakitęs.
  const executable = detected.packageManager === "pnpm" ? await resolvePnpmExecutable() : { command: detected.packageManager, args: [] };
  const request: ProductInstallRequest = {
    cwd: worktreeAbs,
    roots: needInstall,
    packageManager: detected.packageManager,
    command: executable.command,
    args: [...executable.args, ...detected.installArgs],
  };
  const commandLine = `${request.command} ${request.args.join(" ")}`;
  await log?.(`WORKTREE BOOTSTRAP: produkto deps install kopijos viduje (${commandLine}) šaknims: ${needInstall.join(", ")}`);

  if (input.runProductInstall === undefined) {
    throw new Error(`produkto deps install '${commandLine}' reikalingas, bet install runner'is nepaduotas`);
  }

  let code: number;
  try {
    code = await input.runProductInstall(request);
  } catch (error) {
    throw new Error(`produkto deps install '${commandLine}' kopijos medyje nulūžo: ${describe(error)}`, { cause: error });
  }
  if (code !== 0) {
    throw new Error(
      `produkto deps install '${commandLine}' kopijos medyje grąžino exit ${code} (šaknys: ${needInstall.join(", ")}) — ` +
        "vaiko kokybės vartai be deps vis tiek kristų",
    );
  }

  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${bootstrapHash ?? ""}\n`, "utf8");
}

/**
 * Idempotentiškas kopijos bootstrap'as. Pakartotinis kvietimas (perimta kopija, retry) nieko
 * negriauna: tikras `dist` katalogas paliekamas, junction'ai paliekami, konfigas perkopijuojamas,
 * produkto install'as nekartojamas tam pačiam lockfile hash'ui.
 */
export async function ensureWorktreeRuntime(input: EnsureWorktreeRuntimeInput): Promise<void> {
  const { projectRoot, worktreeAbs, layout, log } = input;

  // dist: rekursyvi KOPIJA. Senas junction'as iš ankstesnės bootstrap'o versijos pašalinamas;
  // tikras katalogas paliekamas — jis jau yra vaiko nuosavas `dist`.
  const distSegments = layout.distDir.split("/");
  const distSource = path.join(projectRoot, ...distSegments);
  const distTarget = path.join(worktreeAbs, ...distSegments);
  const distStats = await lstatOrUndefined(distTarget);
  if (distStats?.isSymbolicLink() === true) await unlink(distTarget);
  if (distStats === undefined || distStats.isSymbolicLink()) {
    if (!(await pathEntryExists(distSource))) {
      // Fail-closed: be `dist` vaiko hook'ai (įskaitant stop/commit tiltą) apskritai neveiktų.
      throw new Error(`pirminio medžio ${layout.distDir} nerastas (${distSource}) — nėra ko kopijuoti į kopiją`);
    }
    await mkdir(path.dirname(distTarget), { recursive: true });
    await cp(distSource, distTarget, { recursive: true });

    // `.buildstamp` mtime atnaujinamas į KOPIJOS momentą. Windows failų kopijavimas išsaugo
    // ŠALTINIO mtime, o `git worktree add` checkout'as visiems `src/*.ts` duoda kopijos sukūrimo
    // laiką — kopijuotas stamp'as visada taptų „senesnis" už `src`, ir šviežumo vartas vaiko
    // hook'uose blokuotų KIEKVIENĄ veiksmą kaip stale. Kopija yra lygiai tokia šviežia kaip
    // pirminis `dist`, kurio vartą loop'as jau praėjo — stamp'as privalo tai atspindėti.
    const stampTarget = path.join(distTarget, BUILD_STAMP);
    const now = new Date();
    try {
      await utimes(stampTarget, now, now);
    } catch (error) {
      if (!isEnoent(error)) {
        throw new Error(
          `kopijuotas dist neturi ${BUILD_STAMP} (${stampTarget}) — be šviežio stamp'o vaiko hook'ai kiekvieną ` +
            `veiksmą matytų kaip stale dist: ${describe(error)}`,
          { cause: error },
        );
      }
      // Šaltinio `dist` pats neturėjo ${BUILD_STAMP} (cp jau baigėsi sėkmingai, medis pilnas) —
      // žymos nebuvimas negali lūžti bootstrap'o. Sukuriama kopijoje, šviežia kaip tik dabar
      // pabaigtas kopijavimas.
      await writeFile(stampTarget, `${now.toISOString()}\n`, "utf8");
      await utimes(stampTarget, now, now);
    }
  }

  // node_modules: junction į pirminį medį (vaikas jį tik skaito).
  const modulesSegments = layout.nodeModulesDir.split("/");
  const modulesTarget = path.join(worktreeAbs, ...modulesSegments);
  if (!(await pathEntryExists(modulesTarget))) {
    await mkdir(path.dirname(modulesTarget), { recursive: true });
    // Junction (ne betipis symlink'as): Windows kataloginiam junction'ui nereikia admin teisių, o
    // POSIX platformose Node tipo argumentą ignoruoja.
    await symlink(path.join(projectRoot, ...modulesSegments), modulesTarget, "junction");
  }

  for (const relative of layout.optionalJunctions) {
    const segments = relative.split("/");
    const source = path.join(projectRoot, ...segments);
    const target = path.join(worktreeAbs, ...segments);
    if (await pathEntryExists(target)) continue;
    if (await pathEntryExists(source)) {
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(source, target, "junction");
      continue;
    }
    // Nebuvimas NĖRA bootstrap'o klaida: patikra kopijoje kris sąžiningai dėl realiai trūkstamo
    // artefakto, o ne dėl paties bootstrap'o.
    await log?.(`WORKTREE BOOTSTRAP: pirminio medžio ${relative} nerastas — junction praleistas`);
  }

  for (const relative of layout.configFiles) {
    const segments = relative.split("/");
    const source = path.join(projectRoot, ...segments);
    if (!(await pathEntryExists(source))) continue;
    const target = path.join(worktreeAbs, ...segments);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }

  for (const relative of layout.configDirs ?? []) {
    const segments = relative.split("/");
    const source = path.join(projectRoot, ...segments);
    if (!(await pathEntryExists(source))) continue;
    const target = path.join(worktreeAbs, ...segments);
    await mkdir(target, { recursive: true });
    // `force: false` čia netinka: pakartotinis bootstrap'as (perimta kopija, retry) privalo
    // atnaujinti konfigus iki pirminio medžio būsenos, kaip ir pavieniai `configFiles`.
    await cp(source, target, { recursive: true });
  }

  // Produkto deps — PO runtime žingsnių: jei jau šie krito, install'o laukti nėra prasmės, o
  // klaidos žinutė lieka arčiausiai priežasties.
  await ensureProductDependencies(input);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
