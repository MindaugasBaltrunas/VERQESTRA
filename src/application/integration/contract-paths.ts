// Kelių klasifikacija kontraktų diff'ui ir conflict detector'iui.
// Behaviour etalon: AG_loop application/integration/contract-diff.ts (kelių klasifikacijos blokas).
//
// Failas atkeliauja ANKSČIAU už likusį contract-diff (VQ-305), nes conflict detector (VQ-303)
// jau dabar vartoja `isGeneratedPath`/`isMigrationPath`, o „ar tai migracija / generuotas
// artefaktas" privalo reikšti TĄ PATĮ abiejuose vartuose — antra šių regex'ų kopija reikštų,
// kad vieni vartai praleidžia tai, ką kiti blokuoja (FQC-12). VQ-305 contract-diff importuos
// iš čia.
import { toComparablePosixPath as toPosix } from "../../shared/paths.js";

const TS_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const JSON_EXTENSION = /\.json$/i;
const SQL_EXTENSION = /\.sql$/i;
const PRISMA_EXTENSION = /\.prisma$/i;
const MIGRATION_PATH = /(^|\/)(?:migrations?|migrate)(?:\/|$)/i;

/** TS/JS šeimos failas — kontraktų ekstrakcijai (`extractContracts`) ta pati aibė kaip čia. */
export function isTsContractPath(filePath: string): boolean {
  return TS_EXTENSIONS.test(toPosix(filePath));
}

export function isJsonContractPath(filePath: string): boolean {
  return JSON_EXTENSION.test(toPosix(filePath));
}

export function isSqlContractPath(filePath: string): boolean {
  return SQL_EXTENSION.test(toPosix(filePath));
}

export function isPrismaContractPath(filePath: string): boolean {
  return PRISMA_EXTENSION.test(toPosix(filePath));
}

/**
 * Keliai, kurie GALI nešti public kontraktą. Sąrašas sąmoningai platus: klaidingai įtrauktas
 * failas kainuoja vieną nereikalingą `unverified` įrašą, kurį pataiso turinio pateikimas, o
 * klaidingai praleistas failas kainuoja tylų sugriautą kontraktą.
 */
export function isContractBearingPath(filePath: string): boolean {
  const file = toPosix(filePath);
  return (
    TS_EXTENSIONS.test(file) ||
    JSON_EXTENSION.test(file) ||
    SQL_EXTENSION.test(file) ||
    PRISMA_EXTENSION.test(file) ||
    /\.ya?ml$/i.test(file)
  );
}

/**
 * Generuojamas artefaktas: jo kontraktas yra IŠVESTINIS iš šaltinio, o ne autoritetas.
 * Naudojamas generated-drift taisyklei contract-diff'e ir write scope klasifikacijai.
 */
export function isGeneratedPath(filePath: string): boolean {
  const file = toPosix(filePath);
  return /(^|\/)(?:generated|dist|build)(?:\/|$)/i.test(file) || /\.generated\.[A-Za-z0-9]+$/i.test(file);
}

/**
 * Ar kelias priklauso migracijų grandinei.
 *
 * Eksportuojama, nes tą patį klausimą užduoda ir conflict detector (task 1119): migracijų
 * grandinė yra GLOBALIAI serializuojamas write scope, todėl „ar tai migracija" turi reikšti tą
 * patį abiejuose vartuose. Antra to paties regexo kopija reikštų, kad vieni vartai praleidžia
 * tai, ką kiti blokuoja.
 */
export function isMigrationPath(filePath: string): boolean {
  return MIGRATION_PATH.test(toPosix(filePath));
}
