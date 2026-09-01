// Izoliuotos kopijos šalinimas PO integracijos (etalono worktree-lifecycle.ts removal
// pusė) su Windows ilgo kelio fallback grandine (gyvas incidentas 2026-08-13: MAX_PATH
// 260, code 255 „Filename too long").

import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  isLeaseActive,
  type WorkerLease,
  type WorkerLeaseClaim,
} from "../../../domain/scheduling/worker-lease-rules.js";
import { nodeFsAdapter } from "../../fs/node-fs-adapter.js";
import { run, type CommandResult } from "../../process/run-process.js";
import { worktreeLayout, type WorktreeIdentity, type WorktreeLayout } from "./worktree-layout.js";
import { worktreeGitFailure } from "./worktree-git-util.js";
import { quarantineWorktree } from "./worktree-owner.js";
import { inspectTaskWorktree } from "./worktree-provision.js";
import { cleanupWorktreeRegistrations } from "./worktree-registration-cleanup.js";
import type { WorktreeQuarantineReason } from "./worktree-state-classifier.js";

/** Kviečiama tik po sėkmingo `fallback-<n>` žingsnio — pirmo bandymo sėkmė žymos neneša. */
export type WorktreeRemovalFallback = "fallback-1" | "fallback-2" | "fallback-3" | "runtime-junk";

/**
 * Kelio prefiksai, kuriuos kopijoje palieka pats runtime, o ne task'o darbas: orkestratoriaus
 * žurnalai/būsena (`vq/`), stop bridge (`AG/state/`, `AG/logs/`), build/deps artefaktai ir
 * failinė saugykla. Kiekvienas GeoGravity merge (14/14 iki 2026-09-01) palikdavo RESIDUE būtent
 * dėl jų: `git worktree remove` be `--force` atsisako, nors integruotas darbas jau pirminiame
 * medyje, o šie keliai jokio neintegruoto turinio neturi. `AG/tasks/**` čia SĄMONINGAI nėra —
 * neperkeltas task failo judesys yra realus pėdsakas, kurį privalo pamatyti žmogus.
 */
const RUNTIME_JUNK_PREFIXES = [
  "vq/",
  "AG/state/",
  "AG/logs/",
  "logs/",
  "dist/",
  "node_modules",
  ".pnpm-store/",
  "storage/",
] as const;

function isRuntimeJunkPath(entry: string): boolean {
  const normalized = entry.replace(/\\/g, "/").replace(/^"|"$/g, "");
  return RUNTIME_JUNK_PREFIXES.some(
    (prefix) => normalized.startsWith(prefix) || normalized === prefix.replace(/\/$/, ""),
  );
}

/**
 * Nešvarūs kopijos keliai iš `git status --porcelain` — FAKTAS, dėl kurio `worktree remove`
 * atsisako. `undefined`, kai pačios patikros įvykdyti nepavyko (tada force NIEKADA nebandomas).
 * Rename eilutės (`R  sena -> nauja`) grąžina abu kelius: junk sprendimui svarbūs abu galai.
 * `-uall` privalomas: be jo nesekamas katalogas kolapsuoja į `?? AG/`, ir prefikso sprendimas
 * matytų tėvą, o ne realius failus po juo.
 */
async function worktreeDirtyPaths(runner: WorktreeGitRunner, worktreePath: string): Promise<string[] | undefined> {
  const status = await runner("git", ["-C", worktreePath, "status", "--porcelain", "-uall"], { cwd: worktreePath });
  if (status.code !== 0) return undefined;
  return status.stdout
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter((entry) => entry !== "")
    .flatMap((entry) => {
      const arrow = entry.indexOf(" -> ");
      return arrow === -1 ? [entry] : [entry.slice(0, arrow), entry.slice(arrow + 4)];
    });
}

export type RemoveWorktreeResult =
  | { status: "removed"; layout: WorktreeLayout; fallback?: WorktreeRemovalFallback }
  | { status: "absent"; layout: WorktreeLayout }
  /** Nuosavybė nepatvirtinta — pašalinti gali tik galiojantis savininkas. */
  | { status: "forbidden"; layout: WorktreeLayout; reason: string }
  /** Būsena neaiški: kopija užrakinta karantinui, o ne pašalinta. */
  | { status: "quarantined"; layout: WorktreeLayout; reasons: WorktreeQuarantineReason[] }
  | { status: "infrastructure"; message: string };

export type WorktreeGitRunner = typeof run;

/**
 * Windows'e `git worktree remove` gali lūžti FS lygiu, kai kelias artėja prie MAX_PATH.
 * Tai NĖRA git turinio klaida — atpažįstama siaurai (kodas + tekstas), kad kitos nesėkmės
 * toliau eitų tiesiai į `infrastructure` be jokio fallback bandymo.
 */
function looksLikeLongPathFailure(result: CommandResult): boolean {
  if (result.code !== 255) return false;
  return /file ?name too long|path too long/i.test(`${result.stdout}\n${result.stderr}`);
}

/** Ilgo kelio prefiksas Windows'e apeina MAX_PATH ribą `fs.rm` iškvietimui. */
function longPathSafe(target: string): string {
  if (process.platform !== "win32") return target;
  const resolved = path.resolve(target);
  return resolved.startsWith("\\\\?\\") ? resolved : `\\\\?\\${resolved}`;
}

/**
 * Fallback grandinė TIK ilgo kelio nesėkmei: `--force`, tada `core.longpaths=true --force`,
 * tada `worktree prune` + `fs.rm` su ilgo kelio prefiksu. Sustoja ties pirmu žingsniu,
 * kuris realiai pašalina katalogą.
 */
function defaultLongPathRemover(target: string): Promise<void> {
  return rm(longPathSafe(target), { recursive: true, force: true });
}

export async function removeWorktreeDirectory(
  runner: WorktreeGitRunner,
  projectRoot: string,
  worktreePath: string,
  remover: (target: string) => Promise<void> = defaultLongPathRemover,
  options: {
    /**
     * Leisti `--force`, kai kopija nešvari VIEN runtime šiukšlėmis (RUNTIME_JUNK_PREFIXES).
     * Įjungiama TIK po-integracinio valymo kelyje (removeTaskWorktree): ten darbas jau
     * pirminiame medyje. Orphan reaper'is šito NENAUDOJA — jo force eina per savo
     * amžiaus vartą ir archyvavimą, ir ankstyvas šalinimas be archyvo čia būtų regresija.
     */
    runtimeJunkForce?: boolean;
  } = {},
): Promise<{ status: "removed"; fallback?: WorktreeRemovalFallback } | { status: "infrastructure"; message: string }> {
  const firstArgs = ["worktree", "remove", worktreePath];
  const first = await runner("git", ["-C", projectRoot, ...firstArgs], { cwd: projectRoot });
  if (first.code === 0) return { status: "removed" };
  if (!looksLikeLongPathFailure(first)) {
    // Atsisakymo priežastis tikrinama FAKTU, ne git teksto atpažinimu: jei kopijos nešvarumas
    // yra VIEN runtime šiukšlės (žr. RUNTIME_JUNK_PREFIXES), `--force` nieko nepraranda —
    // integruotas darbas jau pirminiame medyje, o šiukšles paliko pats runtime. Bet koks
    // kitas nešvarus kelias (arba neįvykusi patikra) palieka ankstesnę elgseną: RESIDUE.
    if (options.runtimeJunkForce === true) {
      const dirty = await worktreeDirtyPaths(runner, worktreePath);
      if (dirty !== undefined && dirty.length > 0 && dirty.every(isRuntimeJunkPath)) {
        const junkForceArgs = ["worktree", "remove", "--force", worktreePath];
        const junkForced = await runner("git", ["-C", projectRoot, ...junkForceArgs], { cwd: projectRoot });
        if (junkForced.code === 0) return { status: "removed", fallback: "runtime-junk" };
        return { status: "infrastructure", message: worktreeGitFailure(junkForced, junkForceArgs) };
      }
    }
    return { status: "infrastructure", message: worktreeGitFailure(first, firstArgs) };
  }

  const forceArgs = ["worktree", "remove", "--force", worktreePath];
  const forced = await runner("git", ["-C", projectRoot, ...forceArgs], { cwd: projectRoot });
  if (forced.code === 0) return { status: "removed", fallback: "fallback-1" };

  const longpathsArgs = ["-c", "core.longpaths=true", "-C", projectRoot, "worktree", "remove", "--force", worktreePath];
  const longpaths = await runner("git", longpathsArgs, { cwd: projectRoot });
  if (longpaths.code === 0) return { status: "removed", fallback: "fallback-2" };

  try {
    await remover(worktreePath);
    await runner("git", ["-C", projectRoot, "worktree", "prune"], { cwd: projectRoot });
  } catch (error) {
    return {
      status: "infrastructure",
      message: `fallback-3 (fs.rm + worktree prune) failed for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (await nodeFsAdapter.exists(worktreePath)) {
    return { status: "infrastructure", message: `fallback-3 (fs.rm + worktree prune) left ${worktreePath} in place` };
  }
  return { status: "removed", fallback: "fallback-3" };
}

/**
 * Pašalina kopiją PO integracijos. Reikalavimai kieti ir netaikomi „force" būdu:
 * kviečiantis procesas privalo turėti galiojantį lease, savininko žyma privalo sutapti, o
 * medis — būti švarus. Bet kas kita reiškia, kad kopijoje dar yra darbo, kurio niekas
 * neperkėlė, todėl ji keliauja į karantiną.
 */
export async function removeTaskWorktree(input: {
  projectRoot: string;
  identity: WorktreeIdentity;
  claim: WorkerLeaseClaim;
  leases: readonly WorkerLease[];
  now?: Date;
  /** Tik testams: git runner'is ilgo kelio nesėkmės mock'inimui be realaus MAX_PATH. */
  runner?: WorktreeGitRunner;
  /** Tik testams: `fallback-3` katalogo šalintojas. */
  remover?: (target: string) => Promise<void>;
}): Promise<RemoveWorktreeResult> {
  const projectRoot = path.resolve(input.projectRoot);
  const layout = worktreeLayout(projectRoot, input.identity);
  const now = input.now ?? new Date();

  const lease = input.leases.find((entry) => entry.lease_id === input.claim.lease_id);
  if (!lease || lease.owner_id !== input.claim.owner_id || lease.fencing_token !== input.claim.fencing_token) {
    return { status: "forbidden", layout, reason: `claim ${input.claim.lease_id} neatitinka nė vieno galiojančio lease` };
  }
  // Atlaisvintas lease vis dar leidžia sutvarkyti savo kopiją (šalinimas vyksta po
  // integracijos), bet PASIBAIGĘS neleidžia: tokio proceso nuosavybė jau galėjo būti perimta.
  if (lease.status === "held" && !isLeaseActive(lease, now)) {
    return { status: "forbidden", layout, reason: `lease ${lease.lease_id} pasibaigė ${lease.expires_at}` };
  }

  const state = await inspectTaskWorktree({ projectRoot, identity: input.identity, claim: input.claim });
  if (state.status === "absent") return { status: "absent", layout };
  if (state.status === "quarantine") {
    await quarantineWorktree({ projectRoot, worktreePath: layout.path, reasons: state.reasons, now });
    return { status: "quarantined", layout, reasons: state.reasons };
  }

  // Po-integracinis kelias: runtime šiukšlių force leidžiamas — darbas jau pirminiame medyje.
  const removal = await removeWorktreeDirectory(input.runner ?? run, projectRoot, layout.path, input.remover, {
    runtimeJunkForce: true,
  });
  if (removal.status !== "removed") return { status: "infrastructure", message: removal.message };

  await pruneWorktrees(projectRoot);
  await removeIfEmptyDir(path.dirname(layout.path));

  return removal.fallback ? { status: "removed", layout, fallback: removal.fallback } : { status: "removed", layout };
}

/**
 * `git worktree prune` PLIUS negyvų `.git/worktrees/<name>/` registracijų ir jose likusio
 * pasenusio `index.lock` valymas (GeoGravity 1179). Plikas prune registraciją palieka, jei
 * joje dar yra `index.lock` — todėl kiekvienas šalinimo kelias eina per šią funkciją, o ne
 * tiesiai per `git worktree prune`. Niekada nemeta: nesėkmė — best-effort log eilutė, ne
 * šalinimo abortas (žr. `cleanupWorktreeRegistrations`, kuri pati niekada nemeta).
 */
export async function pruneWorktrees(projectRoot: string): Promise<void> {
  const result = await cleanupWorktreeRegistrations({ projectRoot });
  if (result.error !== undefined) {
    process.stderr.write(`[worktree-removal] registration cleanup failed: ${result.error}\n`);
  }
}

/**
 * Pašalina run'o katalogą TIK jei jis tuščias. Rekursinis trynimas čia būtų klaida: tame
 * pačiame kataloge gali stovėti kito worker'io gyva kopija.
 */
export async function removeIfEmptyDir(dir: string): Promise<void> {
  try {
    if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true });
  } catch {
    // Katalogo nebėra arba jis neprieinamas — valymas yra geriausių pastangų žingsnis.
  }
}
