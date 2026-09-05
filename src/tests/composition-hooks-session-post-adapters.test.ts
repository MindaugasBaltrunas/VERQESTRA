// Sesijos ciklo ir `PostToolUse` hook'ų SURIŠIMO testai (task 237; pilnas auditas 2026-09-05, T4).
//
// Antra to paties trūkumo pusė kaip `composition-hooks-pre-guard-adapters.test.ts`:
// `session-adapters.ts` (`sessionHookPorts`, `sessionSummaryPorts`, `userPromptDeps`) ir
// `adapters.ts` (`postHookPorts`) neturėjo nė vieno importuojančio testo. Visi portai čia
// konstruojami su realia `mkdtemp` šaknimi ir tikrinami prieš tikrą diską.
//
// Ką šis failas SĄMONINGAI tikrina tik forma:
//
//   • `readStdin` (`sessionHookPorts.stdin`, `postHookPorts.stdin`) — jis laukia `process.stdin`
//     EOF, kurio `node --test` procese nebūna, tad kvietimas pakabintų visą rinkinį. Dėl tos
//     pačios priežasties čia NEPALEIDŽIAMI patys `hookSessionStart`/`hookSessionEnd`: ne-TTY
//     bėgime jie eina būtent į stdin skaitymą.
//   • `runShell`-tipo laisvos formos komandos. `gitStatusForPath` ir `runSessionSummary` yra
//     vieninteliai realūs vaikiniai procesai, ir jų tikrinamas kontraktas yra „grąžina rezultatą,
//     o ne meta" — ne konkretus git verdiktas, kuris priklausytų nuo to, ar `tmpdir` atsitiktinai
//     guli po kokiu nors repo.
//
// `assertHookFsBehavesLikeNodeAdapter` yra ta pati konformanso deklaracija kaip pre/guard faile
// (bendro helper'io nėra sąmoningai: task'o `## Failai` leidžia tik šiuos du testų failus, o
// trečias, bendras, būtų už scope ribų). Užfiksuoti faktai — ne norai:
//   • `writeTextFile`/`appendTextFile` į neegzistuojantį katalogą PAVYKSTA (`mkdir -p`);
//   • `readTextFileIfExists(katalogas)` → `undefined` (EISDIR gaudomas), nemeta;
//   • `readContendedTextFileIfExists` grąžina `undefined` VISOMS klaidoms — tuo ir skiriasi nuo
//     `readTextFileIfExists`, kuri gaudo tik ENOENT/EISDIR/ENOTDIR;
//   • `removeFile`/`removeIfExists` nesamam failui tyli, o `renamePath` nesamam šaltiniui META.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { postHookPorts } from "../composition/hooks/adapters.js";
import {
  sessionHookPorts,
  sessionSummaryPorts,
  userPromptDeps,
} from "../composition/hooks/session-adapters.js";
import {
  hookSessionSummary,
  hookUserPrompt,
  type HookFsPort,
  type HookIo,
} from "../interfaces/hooks/index.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

type Project = { projectRoot: string; runtimeRoot: string };

async function makeProject(prefix: string): Promise<Project> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(projectRoot);
  return { projectRoot, runtimeRoot: path.join(projectRoot, "vq") };
}

function captureIo(): { io: HookIo; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (line) => lines.push(line), error: (line) => lines.push(line) }, lines };
}

/** Tas pats `HookFsPort` konformanso kontraktas kaip pre/guard faile (žr. antraštę). */
async function assertHookFsBehavesLikeNodeAdapter(fs: HookFsPort, root: string, label: string): Promise<void> {
  assert.equal(await fs.exists(root), true, `${label}: exists(katalogas) → true`);
  assert.equal(await fs.exists(path.join(root, "nera-tokio")), false, `${label}: exists(nėra) → false`);

  const deep = path.join(root, "a", "b", "c");
  await fs.makeDirectory(deep);
  assert.equal(await fs.exists(deep), true, `${label}: makeDirectory rekursyvus`);
  await fs.makeDirectory(deep);

  assert.equal(
    await fs.readTextFileIfExists(path.join(root, "nera-tokio.txt")),
    undefined,
    `${label}: readTextFileIfExists trūkstamam → undefined`,
  );

  const nested = path.join(root, "x", "y", "z.txt");
  await fs.writeTextFile(nested, "pirmas\n");
  assert.equal(await fs.readTextFileIfExists(nested), "pirmas\n", `${label}: writeTextFile kuria tėvus`);
  await fs.writeTextFile(nested, "antras\n");
  assert.equal(await fs.readTextFileIfExists(nested), "antras\n", `${label}: writeTextFile perrašo`);

  const appended = path.join(root, "p", "q", "log.txt");
  await fs.appendTextFile(appended, "a\n");
  await fs.appendTextFile(appended, "b\n");
  assert.equal(await fs.readTextFileIfExists(appended), "a\nb\n", `${label}: appendTextFile kuria tėvus ir prideda`);

  assert.equal(await fs.readTextFileIfExists(deep), undefined, `${label}: readTextFileIfExists(katalogas) → undefined`);
  assert.equal(
    await fs.readTextFileIfExists(path.join(nested, "toliau.txt")),
    undefined,
    `${label}: readTextFileIfExists(kelias per failą) → undefined`,
  );
}

// ---------------------------------------------------------------------------
// sessionHookPorts
// ---------------------------------------------------------------------------

test("sessionHookPorts: fs portas elgiasi kaip nodeFsAdapter, įskaitant platesnius metodus", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-session-fs-");
  const fs = sessionHookPorts(runtimeRoot).fs;
  await assertHookFsBehavesLikeNodeAdapter(fs, projectRoot, "sessionHookPorts.fs");

  // Sesijos portas platesnis už `HookFsPort` — šie keturi yra jo, ir jų elgesys skiriasi.
  const file = path.join(projectRoot, "sesija", "irasas.md");
  await fs.writeTextFile(file, "turinys\n");
  assert.equal(typeof (await fs.fileMtimeMs(file)), "number", "fileMtimeMs esamam → skaičius");
  assert.equal(await fs.fileMtimeMs(path.join(projectRoot, "nera.md")), undefined, "fileMtimeMs nesamam → undefined");

  // `listMarkdownFiles` grąžina ABSOLIUČIUS `.md` kelius ir tik failus.
  await fs.writeTextFile(path.join(projectRoot, "sesija", "kitas.txt"), "x\n");
  await fs.makeDirectory(path.join(projectRoot, "sesija", "pokatalogis.md"));
  assert.deepEqual(await fs.listMarkdownFiles(path.join(projectRoot, "sesija")), [file]);
  assert.deepEqual(await fs.listMarkdownFiles(path.join(projectRoot, "nera-katalogo")), [], "nesamas katalogas → []");

  // `renamePath` META nesamam šaltiniui (lock protokolas iš nesėkmės sprendžia), o
  // `removeIfExists` tyli visada — tai DVI skirtingos klaidų politikos tame pačiame porte.
  const renamed = path.join(projectRoot, "sesija", "pervadinta.md");
  await fs.renamePath(file, renamed);
  assert.equal(await fs.exists(renamed), true);
  await assert.rejects(() => fs.renamePath(file, renamed), "renamePath nesamam šaltiniui privalo mesti");
  await fs.removeIfExists(renamed);
  assert.equal(await fs.exists(renamed), false);
  await fs.removeIfExists(renamed);
});

test("sessionHookPorts: proceso, aplinkos ir git portai surišti su realiu runtime", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-session-proc-");
  const ports = sessionHookPorts(runtimeRoot);

  assert.equal(ports.processIsAlive(process.pid), true, "šis procesas gyvas");
  assert.equal(ports.processIsAlive(2_147_483_646), false, "neegzistuojantis pid → false");
  assert.equal(typeof ports.parentPid(), "number", "parentPid — process.ppid");
  assert.equal(typeof ports.stdinIsInteractive(), "boolean", "TTY būsena — boolean, ne undefined");
  assert.equal(ports.env("VQ_NERA_TOKIO_KINTAMOJO_237"), undefined, "nesamas env → undefined");

  // `gitStatusPorcelain` čia yra KODO ir teksto pora: tuščias tekstas su ne-nuliniu kodu reiškia
  // „git neatsakė", ir sulieti jį su švariu medžiu būtų klaida. Konkretus kodas priklauso nuo to,
  // ar `tmpdir` guli po kokiu nors repo, tad pin'inama pora, ne verdiktas.
  const status = await ports.gitStatusPorcelain(projectRoot);
  assert.equal(typeof status.code, "number");
  assert.equal(typeof status.stdout, "string");

  // Checkpoint'o nėra — `undefined`, ne išimtis. Portas kalba `stateDir` kalba.
  assert.equal(await ports.readDispatchCheckpoint(path.join(runtimeRoot, "state")), undefined);

  // `collectChangedFiles` ne git kataloge remiasi VIEN `changes.log` — realiu, ne fake'u.
  assert.deepEqual(await ports.collectChangedFiles(projectRoot), []);
  await nodeFsAdapter.writeTextFile(
    path.join(runtimeRoot, "logs", "changes.log"),
    "[2026-09-05T00:00:00.000Z] MODIFIED: src/pakeista.ts\n",
  );
  assert.deepEqual(await ports.collectChangedFiles(projectRoot), ["src/pakeista.ts"]);

  // Forma be kvietimo (žr. antraštę).
  assert.equal(typeof ports.stdin.readStdin, "function");
});

test("sessionHookPorts: runSessionSummary paleidžia REALŲ vaikinį CLI procesą", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-session-child-");

  // Vienintelis vaikas šiam portui. Kontraktas: `runCliChild` grąžina kodą, o ne meta, ir
  // projekto šaknis vaikui keliauja per `CLAUDE_PROJECT_DIR` — tik todėl santrauka atsiranda
  // MŪSŲ tmp kopijoje, o ne ten, iš kur paleistas testas.
  const code = await sessionHookPorts(runtimeRoot).runSessionSummary(projectRoot);
  assert.equal(code, 0, "hook-session-summary yra ataskaita — ji niekada neblokuoja");
  assert.equal(
    await nodeFsAdapter.exists(path.join(runtimeRoot, "logs", "session-summary.md")),
    true,
    "vaikas rašo į paduotą projekto šaknį",
  );
});

// ---------------------------------------------------------------------------
// sessionSummaryPorts
// ---------------------------------------------------------------------------

test("sessionSummaryPorts: end-to-end santrauka per realų fs", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-summary-");
  const ports = sessionSummaryPorts(runtimeRoot);
  const sandbox = path.join(projectRoot, "fs");
  await nodeFsAdapter.makeDirectory(sandbox);
  await assertHookFsBehavesLikeNodeAdapter(ports.fs, sandbox, "sessionSummaryPorts.fs");

  // `fileSizeBytes`: failas → baitai, katalogas ir nesamas kelias → `undefined` (guard žurnalų
  // sekcija tuo skiria „žurnalo nėra" nuo „žurnalas tuščias").
  const log = path.join(runtimeRoot, "logs", "backend-guard.log");
  await ports.fs.writeTextFile(log, "skipped: nieko\n");
  assert.equal(await ports.fs.fileSizeBytes(log), "skipped: nieko\n".length);
  assert.equal(await ports.fs.fileSizeBytes(path.join(runtimeRoot, "logs")), undefined, "katalogas → undefined");
  assert.equal(await ports.fs.fileSizeBytes(path.join(runtimeRoot, "nera.log")), undefined);

  assert.equal(await ports.isGitRepository(projectRoot), false, "tmp katalogas nėra git repo");
  assert.equal(await ports.gitStatusText(projectRoot), "", "git neprieinamas → tuščias tekstas, ne išimtis");

  await ports.fs.appendTextFile(
    path.join(runtimeRoot, "logs", "hooks.log"),
    "[2026-09-05T00:00:00.000Z] bash: pnpm test\n",
  );

  const { io } = captureIo();
  const code = await hookSessionSummary({ ports, projectRoot, runtimeRoot, io });
  assert.equal(code, 0, "santrauka niekada neblokuoja");

  const summary = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "logs", "session-summary.md"));
  assert.ok(summary?.startsWith("# Session Summary"), `santrauka parašyta diske: ${summary?.slice(0, 40)}`);
  assert.ok(summary?.includes("- Git repository unavailable"), "ne git repo pažymimas eksplicitiškai");
  assert.ok(summary?.includes("- pnpm test"), "komandų sekcija skaito realų hooks.log");
  const history = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "logs", "history.log"));
  assert.ok(history?.includes("SESSION_SUMMARY"), `history.log: ${history}`);
});

// ---------------------------------------------------------------------------
// userPromptDeps
// ---------------------------------------------------------------------------

test("userPromptDeps: be agents.json — numatytoji politika, su juo — TIK įjungti vaidmenys", async () => {
  const { runtimeRoot } = await makeProject("vq-prompt-agents-");

  // Trūkstamas registras nėra klaida: `loadAgentPolicy` grąžina numatytąją politiką, tad
  // santrauka lieka pilna. Būtent todėl `agentSummary` čia NĖRA `undefined`.
  const withoutConfig = await userPromptDeps(runtimeRoot);
  assert.equal(withoutConfig.runtimeRoot, runtimeRoot, "deps neša tą pačią šaknį, su kuria surišta");
  assert.ok(withoutConfig.agentSummary?.includes("coder"), `numatytieji vaidmenys: ${withoutConfig.agentSummary}`);

  // Realus registras diske: `enabled: false` vaidmuo iš santraukos IŠKRENTA. `default_role`
  // išjungti negalima (politika to neleidžia), tad išjungiamas `i18n`.
  await nodeFsAdapter.writeTextFile(
    path.join(runtimeRoot, "config", "agents.json"),
    JSON.stringify({
      version: "1.0.0",
      default_role: "coder",
      roles: {
        coder: { allowed_adapters: ["claude"], default_model_hint: "sonnet", can_write_code: true },
        i18n: { allowed_adapters: ["claude"], default_model_hint: "haiku", can_write_code: true, enabled: false },
      },
    }),
  );
  assert.equal((await userPromptDeps(runtimeRoot)).agentSummary, "coder", "išjungtas vaidmuo nepatenka į santrauką");

  // Sugadintas registras — santrauka nutylima (`undefined`), o modulis krenta į savo numatytąjį
  // tekstą. Hook'as niekada neblokuoja dėl konfigo, tad tai fail-safe, ne fail-closed vieta.
  await nodeFsAdapter.writeTextFile(path.join(runtimeRoot, "config", "agents.json"), "{ne json");
  assert.equal((await userPromptDeps(runtimeRoot)).agentSummary, undefined);
});

test("userPromptDeps: end-to-end UserPromptSubmit — vėliava realiame diske riboja iki vieno karto", async () => {
  const { runtimeRoot } = await makeProject("vq-prompt-");
  const { io, lines } = captureIo();

  const deps = await userPromptDeps(runtimeRoot, io);
  assert.equal(await hookUserPrompt(deps), 0);
  assert.equal(lines.length, 1, "kontekstas pateiktas vieną kartą");
  assert.ok(lines[0]?.includes("Projekto orkestratoriaus kontekstas"));
  assert.equal(await nodeFsAdapter.exists(path.join(runtimeRoot, "logs", ".context-shown")), true, "vėliava diske");

  // Antras kvietimas mato TĄ PAČIĄ vėliavą per tą patį realų fs — jokio antro bloko.
  assert.equal(await hookUserPrompt(await userPromptDeps(runtimeRoot, io)), 0);
  assert.equal(lines.length, 1, "vėliava neleidžia kartoti bloko toje pačioje sesijoje");
});

// ---------------------------------------------------------------------------
// postHookPorts
// ---------------------------------------------------------------------------

test("postHookPorts: fs portas elgiasi kaip nodeFsAdapter", async () => {
  const { projectRoot } = await makeProject("vq-post-fs-");
  const fs = postHookPorts().fs;

  // `postHookPorts` runtime šaknies neima — ji ateina su `PostHookDeps`. Tas pats fs objektas
  // aptarnauja bet kurią šaknį, tad konformansas tikrinamas tiesiog tmp kataloge.
  await assertHookFsBehavesLikeNodeAdapter(fs, projectRoot, "postHookPorts.fs");
});

test("postHookPorts: ledger'io metodai — exclusive rašymas, contended skaitymas, trynimas", async () => {
  const { projectRoot } = await makeProject("vq-post-ledger-");
  const fs = postHookPorts().fs;
  const lock = path.join(projectRoot, "state", "ledger.lock");

  // `writeFileExclusive` yra lock'o perėmimas: pirmas laimi, antras gauna "exists", NE išimtį.
  assert.equal(await fs.writeFileExclusive(lock, "savininkas\n"), "created");
  assert.equal(await fs.writeFileExclusive(lock, "kitas\n"), "exists", "užimtas lock'as nemeta");
  assert.equal(await fs.readContendedTextFileIfExists(lock), "savininkas\n", "turinys nepakeistas");

  // `readContendedTextFileIfExists` praryja VISKĄ — tuo ji ir skiriasi nuo
  // `readTextFileIfExists`, kuri gaudo tik ENOENT/EISDIR/ENOTDIR (task 238 fake'ui šis
  // skirtumas yra esminis: abi čia grąžina `undefined`, bet dėl skirtingų priežasčių).
  assert.equal(await fs.readContendedTextFileIfExists(path.join(projectRoot, "nera.lock")), undefined);
  assert.equal(await fs.readContendedTextFileIfExists(path.join(projectRoot, "state")), undefined, "katalogas");
  assert.equal(await fs.readTextFileIfExists(path.join(projectRoot, "state")), undefined, "katalogas");

  const moved = path.join(projectRoot, "state", "ledger.taken");
  await fs.renamePath(lock, moved);
  assert.equal(await fs.exists(lock), false);
  assert.equal(typeof (await fs.fileMtimeMs(moved)), "number");

  // `removeFile` nesamam failui TYLI (`rm force:true`), nors kitomis klaidomis meta.
  await fs.removeFile(moved);
  assert.equal(await fs.exists(moved), false);
  await fs.removeFile(moved);
});

test("postHookPorts: kompresijos konfigas, git zondas ir env surišti be išimčių", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-post-ports-");
  const ports = postHookPorts();

  // UŽFIKSUOTAS FAKTAS, o ne noras: trūkstamas konfigas NĖRA klaida — `loadContextCompressionConfig`
  // grąžina numatytąjį vaizdą su VISOMIS funkcijomis išjungtomis. `undefined` rezervuotas TIK
  // neperskaitomam turiniui, kurį `postHookPorts` `.catch()` paverčia „funkcija išjungta":
  // PostToolUse išimtis reikštų užblokuotą tool call'ą.
  const configPath = path.join(runtimeRoot, "config", "context-compression.json");
  const missing = await ports.loadCompressionConfig(runtimeRoot);
  assert.equal(missing?.version, 1, "nesamas konfigas → numatytasis vaizdas, ne undefined");
  assert.deepEqual(
    Object.values(missing?.features ?? {}).filter(Boolean),
    [],
    "numatytajame vaizde nė viena funkcija neįjungta",
  );

  await nodeFsAdapter.writeTextFile(configPath, "{ne json");
  assert.equal(await ports.loadCompressionConfig(runtimeRoot), undefined, "sugadintas konfigas → undefined");

  // Realus `git status` zondas vienam keliui. Pin'inama forma, ne verdiktas: konkretus kodas
  // priklauso nuo to, ar `tmpdir` atsitiktinai guli po kokiu nors repo. Kontraktas — pora
  // `{code, stdout}`, niekada ne išimtis (nepaleistas git reiškia „nežinau", ne klaidą).
  const probe = await ports.gitStatusForPath(projectRoot, "src/demo.ts");
  assert.equal(typeof probe.code, "number");
  assert.equal(typeof probe.stdout, "string");

  assert.equal(ports.env("VQ_NERA_TOKIO_KINTAMOJO_237"), undefined);
  assert.equal(typeof ports.stdin.readStdin, "function");
});
