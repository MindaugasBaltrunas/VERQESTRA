// Task 079 (GeoGravity auditas 2026-08-29): branch-blocked mirties spiralė — orphan reaper
// paliko amžinus "ORPHAN KEPT" įrašus untracked/check-failed kopijoms, nematė FS-lygio
// katalogų be git registracijos ir limitą viršiję kandidatai badaudavo amžinai. Šis failas
// laikomas ATSKIRAI nuo infrastructure-worktrees.test.ts, kuris jau buvo prie 500 eilučių ribos.

import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkerLease } from "../domain/scheduling/worker-lease-rules.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { run } from "../infrastructure/process/run-process.js";
import { WORKTREE_ROOT_DIR } from "../infrastructure/git/worktrees/worktree-layout.js";
import { createTaskWorktree } from "../infrastructure/git/worktrees/worktree-provision.js";
import { reapOrphanWorktrees } from "../infrastructure/git/worktrees/orphan-worktree-reaper.js";

/** Izoliuota repo laikinam kataloge — kiekvienas testas gauna savo, kad orphan'ai nesimaišytų. */
async function initEphemeralRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  async function git(...args: string[]): Promise<{ code: number; stdout: string }> {
    const result = await run("git", ["-C", dir, ...args]);
    assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return result;
  }
  await git("init");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.autocrlf", "false");
  await nodeFsAdapter.writeTextFile(path.join(dir, ".gitignore"), ".ag/\n");
  await nodeFsAdapter.writeTextFile(path.join(dir, "src", "a.ts"), "pradinis\n");
  await git("add", "--all");
  await git("commit", "-m", "pradinis");
  return dir;
}

function lease(overrides: Partial<WorkerLease> = {}): WorkerLease {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  return {
    schema_version: 1,
    lease_id: "lease-1",
    status: "held",
    fencing_token: 1,
    owner_id: "owner-1",
    run_id: "r1",
    worker_id: "w1",
    task_id: "t1",
    attempt: 1,
    acquired_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    expires_at: future,
    ...overrides,
  };
}

const GIT_STATUS_VISIBILITY_POLL_MS = 25;
const GIT_STATUS_VISIBILITY_TIMEOUT_MS = 5_000;

/**
 * `git worktree remove` (be --force) atsisako šalinti TIK jei jo vidinis FS skenas MATO
 * untracked failą tuo momentu. Testas rašo failą per `nodeFsAdapter.writeTextFile`
 * (atominis tmp+rename) ir iškart kviečia reap'ą — Windows'e rename matomumas git status
 * skenui gali atsilikti kelias dešimtis ms (FS metaduomenų/AV-indexer vėlavimas), todėl KEPT
 * lūkestis pirmam kvietimui yra prielaida, kurią reikia patikrinti FAKTU prieš tikrinant
 * pasekmę, o ne vien tikėtis. Ribotas laukimas: jei git per timeout'ą failo neišvys, testas
 * krenta su aiškia priežastimi vietoj to, kad tyliai gautų klaidingą REAPED.
 */
async function waitForGitStatusVisibility(worktreePath: string, relativeFilePath: string): Promise<void> {
  const needle = relativeFilePath.split(path.sep).join("/");
  const deadline = Date.now() + GIT_STATUS_VISIBILITY_TIMEOUT_MS;
  for (;;) {
    const result = await run("git", ["-C", worktreePath, "status", "--porcelain", "-uall"]);
    assert.equal(result.code, 0, `git status failed: ${result.stderr || result.stdout}`);
    if (result.stdout.includes(needle)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `git per ${GIT_STATUS_VISIBILITY_TIMEOUT_MS}ms nepamatė ką tik įrašyto failo ${needle} kopijoje ${worktreePath}`,
      );
    }
    await delay(GIT_STATUS_VISIBILITY_POLL_MS);
  }
}

// Runtime keliai (vq/state/...) yra ignoruojami nonRuntimeDirtyEntriesFromStatus, tad
// reapTreeState mato "clean" — bet `git worktree remove` (be --force) vis tiek atsisako
// šalinti, nes untracked failas realiai yra medyje. Anksčiau tai virsdavo amžinu
// "ORPHAN KEPT: reason=check-failed", nes eskalacija reikalavo IR 24 h amžiaus, IR `done`
// task'o bucket'o — o task'as niekada nepasiekia `done`, kol jo kopija laiko šakos vardą.
// Dabar amžius VIENAS pats (be bucket'o) po lease TTL užtenka.
test("orphan reap: runtime-only untracked failas nebelieka amžinu KEPT - preserve+force po lease TTL", async () => {
  const spiralRoot = await initEphemeralRepo("vq-wt-spiral-");
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "vq-wt-spiral-runtime-"));
  const agRoot = await mkdtemp(path.join(tmpdir(), "vq-wt-spiral-agroot-"));
  try {
    const spiralIdentity = { run_id: "r1", worker_id: "w1", task_id: "t-spiral", attempt: 1 };
    const created = await createTaskWorktree({
      projectRoot: spiralRoot,
      identity: spiralIdentity,
      lease: lease({ lease_id: "lease-spiral", fencing_token: 40, task_id: "t-spiral" }),
      baseRef: "HEAD",
    });
    assert.equal(created.status, "created", JSON.stringify(created));
    if (created.status !== "created") return;

    // Task'as VIS DAR eilėje (ne `done`) — būtent tai anksčiau blokuodavo eskalaciją amžinai.
    await nodeFsAdapter.writeTextFile(path.join(agRoot, "tasks", "queue", "t-spiral.md"), "# t-spiral\n");
    const leftoverRelativePath = path.join("vq", "state", "leftover.txt");
    await nodeFsAdapter.writeTextFile(path.join(created.layout.path, leftoverRelativePath), "liekana\n");
    // Prielaida „git jau mato ką tik įrašytą failą" patikrinama FAKTU (žr. funkcijos
    // komentarą) — kitaip pirmas reap gali praeiti be --force ir grąžinti klaidingą REAPED.
    await waitForGitStatusVisibility(created.layout.path, leftoverRelativePath);

    // Per anksti (amžius=0, task dar eilėje): nei amžius, nei bucket'as eligible - lieka KEPT.
    const tooSoon = await reapOrphanWorktrees({ projectRoot: spiralRoot, runtimeRoot, agRoot, leases: [] });
    assert.ok(
      tooSoon.some((line) => line.startsWith("ORPHAN KEPT") && line.includes("t-spiral")),
      tooSoon.join("\n"),
    );
    assert.equal(await nodeFsAdapter.exists(created.layout.path), true);

    // Praėjus lease TTL (task VIS DAR eilėje!) - amžiaus vartas vienas pats jau užtenka.
    const laterNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const lines = await reapOrphanWorktrees({ projectRoot: spiralRoot, runtimeRoot, agRoot, leases: [], now: laterNow });

    assert.ok(
      lines.some((line) => line.startsWith("ORPHAN REAPED") && line.includes("archive=")),
      lines.join("\n"),
    );
    assert.equal(await nodeFsAdapter.exists(created.layout.path), false, "kopija turi būti pašalinta su --force");
    const archiveFiles = await nodeFsAdapter.listFiles(path.join(runtimeRoot, "state", "worktree-archive"));
    assert.ok(archiveFiles.length > 0, "turinys turi būti archyvuotas prieš force šalinimą");
  } finally {
    await rm(spiralRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(agRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("orphan reap: FS-lygio GC pašalina katalogus be git registracijos, registruotus palieka", async () => {
  const gcRoot = await initEphemeralRepo("vq-wt-gc-");
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "vq-wt-gc-runtime-"));
  const agRoot = await mkdtemp(path.join(tmpdir(), "vq-wt-gc-agroot-"));
  try {
    // Registruota, GYVA kopija - GC ir orphan reap privalo ją palikti nepaliestą.
    const liveIdentity = { run_id: "rgc", worker_id: "w1", task_id: "t-live", attempt: 1 };
    const liveLease = lease({ lease_id: "lease-gc-live", fencing_token: 50, task_id: "t-live" });
    const liveCreated = await createTaskWorktree({
      projectRoot: gcRoot,
      identity: liveIdentity,
      lease: liveLease,
      baseRef: "HEAD",
    });
    assert.equal(liveCreated.status, "created", JSON.stringify(liveCreated));
    if (liveCreated.status !== "created") return;

    // Sena, be jokios git registracijos - tik plikas katalogas tame pačiame run_id.
    const staleDir = path.join(gcRoot, WORKTREE_ROOT_DIR, "rgc", "w1-t-stale-a1");
    await nodeFsAdapter.writeTextFile(path.join(staleDir, "junk.txt"), "liekana\n");
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(staleDir, staleTime, staleTime);

    // Jauna, be registracijos - dar gali būti vidury provizionavimo, GC neturi liesti.
    const freshDir = path.join(gcRoot, WORKTREE_ROOT_DIR, "rgc", "w1-t-fresh-a1");
    await nodeFsAdapter.writeTextFile(path.join(freshDir, "junk.txt"), "liekana\n");

    const lines = await reapOrphanWorktrees({ projectRoot: gcRoot, runtimeRoot, agRoot, leases: [liveLease] });

    assert.ok(
      lines.some((line) => line.startsWith("ORPHAN DIR REMOVED") && line.includes("w1-t-stale-a1")),
      lines.join("\n"),
    );
    assert.equal(await nodeFsAdapter.exists(staleDir), false, "senas katalogas be registracijos turi būti pašalintas");
    assert.equal(await nodeFsAdapter.exists(freshDir), true, "jaunas katalogas be registracijos dar neliečiamas");
    assert.equal(await nodeFsAdapter.exists(liveCreated.layout.path), true, "registruota gyva kopija neliečiama");
  } finally {
    await rm(gcRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(agRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("orphan reap: limitą viršiję kandidatai imami kito praėjimo PRADŽIOJE, ne badauja", async () => {
  const truncRoot = await initEphemeralRepo("vq-wt-trunc-");
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "vq-wt-trunc-runtime-"));
  const agRoot = await mkdtemp(path.join(tmpdir(), "vq-wt-trunc-agroot-"));
  try {
    async function makeOrphan(taskId: string, fencingToken: number): Promise<string> {
      const made = await createTaskWorktree({
        projectRoot: truncRoot,
        identity: { run_id: "rtrunc", worker_id: "w1", task_id: taskId, attempt: 1 },
        lease: lease({ lease_id: `lease-${taskId}`, fencing_token: fencingToken, task_id: taskId }),
        baseRef: "HEAD",
      });
      assert.equal(made.status, "created", JSON.stringify(made));
      if (made.status !== "created") throw new Error("nepavyko sukurti orphan worktree");
      return made.layout.path;
    }

    const paths = new Map<string, string>();
    for (let i = 1; i <= 22; i += 1) {
      const taskId = `task-a-${String(i).padStart(2, "0")}`;
      paths.set(taskId, await makeOrphan(taskId, 60 + i));
    }

    const first = await reapOrphanWorktrees({ projectRoot: truncRoot, runtimeRoot, agRoot, leases: [], limit: 20 });
    assert.ok(
      first.some((line) => line.startsWith("ORPHAN REAP TRUNCATED") && line.includes("liko 2")),
      first.join("\n"),
    );
    assert.equal(await nodeFsAdapter.exists(paths.get("task-a-01")!), false);
    assert.equal(await nodeFsAdapter.exists(paths.get("task-a-20")!), false);
    assert.equal(await nodeFsAdapter.exists(paths.get("task-a-21")!), true);
    assert.equal(await nodeFsAdapter.exists(paths.get("task-a-22")!), true);

    // Naujas kandidatas, ALFABETIŠKAI ANKSTESNIS už nukirptuosius - be eilės jis laimėtų
    // vienintelį slot'ą ir "task-a-21"/"task-a-22" badautų toliau. Su eile - PIRMIAUSIA imami
    // praėjusio praėjimo nukirptieji, nepriklausomai nuo alfabetinės tvarkos.
    paths.set("task-a-00", await makeOrphan("task-a-00", 99));

    const second = await reapOrphanWorktrees({ projectRoot: truncRoot, runtimeRoot, agRoot, leases: [], limit: 1 });
    assert.ok(
      second.some((line) => line.startsWith("ORPHAN REAPED") && line.includes("task-a-21")),
      second.join("\n"),
    );
    assert.equal(await nodeFsAdapter.exists(paths.get("task-a-21")!), false, "nukirptas kandidatas imamas PIRMAS");
    assert.equal(await nodeFsAdapter.exists(paths.get("task-a-22")!), true);
    assert.equal(
      await nodeFsAdapter.exists(paths.get("task-a-00")!),
      true,
      "naujas alfabetiškai ankstesnis kandidatas laukia savo eilės",
    );
  } finally {
    await rm(truncRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(agRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
