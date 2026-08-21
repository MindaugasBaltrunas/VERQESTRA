// Kokybės vartų MEMO saugykla (etalonas: AG_loop application/quality-gates/gates-memo.ts IO pusė).
//
// Memo atsako į vieną klausimą: ar medis nuo paskutinio ŽALIO paleidimo nepasikeitė? Jei ne,
// identiško medžio pertikrinimas neduoda informacijos, ir suite praleidžiamas. Todėl viskas
// priklauso nuo TAPATYBĖS tikslumo — jos klaida čia reikštų tylų vartų praleidimą.
//
// Tapatybę sudaro trys dalys, ir kiekviena būtina:
//   - MEDŽIO tree hash (įskaitant nesekamus failus): pats darbo turinys;
//   - `dist` turinio hash: vartai vykdo BUILD'INTĄ kodą, tad pasikeitęs `dist` prie to paties
//     `src` yra kitas paleidimas;
//   - vartų POLITIKOS hash: pakeitus komandas, senas žalias verdiktas nieko nebesako.
//
// Tree hash skaičiuojamas per LAIKINĄ indeksą OS temp kataloge, o ne repozitorijoje. Indeksas
// medyje būtų savidestrukcinis: `git add -A` įtrauktų jį patį, tad kiekvienas skaičiavimas duotų
// NAUJĄ hash'ą ir memo nepataikytų niekada. Šiame repo `vq/` yra gitignore'intas ir problema
// nesimatytų, bet taikinio projekte, kur jis netyčia sekamas, mechanizmas tyliai virstų nuliniu.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  gatesMemoKey,
  gatesMemoPath,
  gatesMemoRecordSchema,
  type GatesMemoPort,
  type GatesMemoReadResult,
} from "../../application/quality-gates/gates-memo.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { toPrettyJson, tryParseJson } from "../../shared/json.js";
import { run } from "./run-process.js";

const TREE_ADD_TIMEOUT_MS = 120_000;
const TREE_WRITE_TIMEOUT_MS = 60_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Laikino git indekso kelias — SĄMONINGAI už darbo medžio ribų (žr. modulio antraštę). */
function memoIndexPath(projectRoot: string): string {
  return path.join(os.tmpdir(), `vq-gates-memo-index-${sha256(path.resolve(projectRoot)).slice(0, 16)}`);
}

/**
 * Viso medžio tree hash per laikiną indeksą.
 *
 * `null` — kai git nepasiekiamas, kelias nėra repozitorija arba indeksą tuo metu užėmė lygiagretus
 * procesas. Visais tais atvejais memo tiesiog NENAUDOJAMAS: nežinia niekada nevirsta praleidimu.
 *
 * Laikinas indeksas TYČIA netrinamas — jis veikia kaip stat cache, be kurio kiekvienas
 * skaičiavimas iš naujo hash'uotų visą medį.
 */
async function computeTreeHash(projectRoot: string): Promise<string | null> {
  const tmpIndex = memoIndexPath(projectRoot);
  await mkdir(path.dirname(tmpIndex), { recursive: true }).catch(() => undefined);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };

  const add = await run("git", ["add", "-A"], { cwd: projectRoot, timeoutMs: TREE_ADD_TIMEOUT_MS, env });
  if (add.code !== 0) return null;
  const tree = await run("git", ["write-tree"], { cwd: projectRoot, timeoutMs: TREE_WRITE_TIMEOUT_MS, env });
  if (tree.code !== 0) return null;
  const value = tree.stdout.trim();
  return value === "" ? null : value;
}

/** Visi failai medyje; nesantis katalogas — tuščias sąrašas. */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listFilesRecursive(full)));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/**
 * `dist` turinio tapatybė: kelias + baitai, rūšiuota tvarka.
 *
 * Neperskaitytas failas duoda TUŠČIĄ tapatybę, o ne dalinę: dalinis hash'as atrodytų kaip
 * galiojanti reikšmė ir galėtų sutapti su kito paleidimo daliniu hash'u.
 */
async function computeDistIdentity(distDir: string): Promise<string> {
  const files = (await listFilesRecursive(distDir)).sort();
  if (files.length === 0) return "";

  const digest = createHash("sha256");
  for (const filePath of files) {
    const raw = await readFile(filePath).catch(() => undefined);
    if (raw === undefined) return "";
    digest.update(path.relative(distDir, filePath).replace(/\\/g, "/"));
    digest.update("\0");
    digest.update(raw);
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function hashFileIfPresent(filePath: string): Promise<string> {
  const raw = await readFile(filePath).catch(() => undefined);
  return raw === undefined ? "" : createHash("sha256").update(raw).digest("hex");
}

export type GatesMemoStoreInput = {
  /** Medis, kurio tapatybė skaičiuojama. */
  projectRoot: string;
  /** `vq` runtime šaknis — memo įrašui ir vartų politikai. */
  runtimeRoot: string;
  /** Katalogas, kurio turinys yra vykdomas kodas (paprastai šio paketo `dist`). */
  distDir: string;
};

export function createGatesMemoPort(input: GatesMemoStoreInput): GatesMemoPort {
  const memoFile = gatesMemoPath(input.runtimeRoot);

  return {
    async identify({ projectRoot, scope, commands }) {
      const tree = await computeTreeHash(projectRoot);
      // Be medžio tapatybės memo negalimas: `null` reiškia „nežinome", ir suite bėga.
      if (tree === null) return null;
      const dist = await computeDistIdentity(input.distDir);
      const config = await hashFileIfPresent(path.join(input.runtimeRoot, "config", "quality-policy.json"));
      return { key: gatesMemoKey({ tree, dist, config, scope, commands }), tree, dist, config };
    },

    async read(): Promise<GatesMemoReadResult> {
      const raw = await nodeFsAdapter.readTextFileIfExists(memoFile);
      if (raw === undefined) return { status: "absent" };

      const parsed = tryParseJson<unknown>(raw);
      if (!parsed.ok) return { status: "corrupted", errors: [`invalid JSON: ${parsed.error.message}`] };
      const validated = gatesMemoRecordSchema.safeParse(parsed.value);
      return validated.success
        ? { status: "hit", record: validated.data }
        : { status: "corrupted", errors: validated.error.issues.map((issue) => issue.message) };
    },

    async write(_projectRoot, record) {
      await nodeFsAdapter.makeDirectory(path.dirname(memoFile));
      // Schema tikrinama ir RAŠANT: sugadintas įrašas neturi atsirasti dėl kvietėjo klaidos, o ne
      // tik būti atmestas skaitant.
      await nodeFsAdapter.writeTextFileAtomic(memoFile, toPrettyJson(gatesMemoRecordSchema.parse(record)));
    },

    clear: () => nodeFsAdapter.removeIfExists(memoFile).then(() => undefined),
  };
}
