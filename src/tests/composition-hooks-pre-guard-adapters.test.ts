// `PreToolUse` ir guard hook'ų SURIŠIMO testai (task 237; pilnas auditas 2026-09-05, T4).
//
// Iki šio failo `composition/hooks/pre-adapters.ts` ir `guard-adapters.ts` neturėjo NĖ VIENO
// importuojančio testo: hook'ų logika buvo dengta gausiai, bet visada per `fakeFs`, o portų
// fabrikų — tų pačių, kuriuos produkcijoje gauna kiekvienas Stop/pre-write vartas — niekas
// neinstancijavo. Vartai, kuriais pasitiki ciklas, ėjo per neišbandytą surišimą.
//
// Todėl čia NĖRA nė vieno fake'o: kiekvienas portas konstruojamas su realia `mkdtemp` šaknimi ir
// tikrinamas prieš tikrą diską. Du dalykai, kurių kompiliatorius neįrodo ir dėl kurių šis failas
// egzistuoja:
//
//   1. `HookFsPort.listDirectoryIfExists` yra NEPRIVALOMAS tipo lauke, o `collectKnownTaskIds`
//      nuo jo priklauso. Pametus jį `preHookPorts` fs objekte kompiliacija liktų žalia, o
//      `## Priklausomybės` nuorodų domenas tyliai susiaurėtų iki ledger'io — būtent ta klaida,
//      kurią 2026-08-30 pagavo tik raudona eilė.
//   2. `fakeFs` (×125 hooks testuose) DREIFUOJA nuo `nodeFsAdapter`: jo `exists` nemato katalogų,
//      `makeDirectory` yra no-op, ir jis niekada nemeta. `assertHookFsBehavesLikeNodeAdapter`
//      užrašo TIKRĄ elgesį kaip vieną vardu pavadintą konformanso kontraktą — task 238 pagal jį
//      suvienodins fake'us, o ne pagal spėjimą.
//
// Ką čia UŽFIKSUOJAME kaip faktą (ne norą): `writeTextFile`/`appendTextFile` į neegzistuojantį
// katalogą PAVYKSTA (abu daro `mkdir -p`), o katalogo skaitymas kaip failo grąžina `undefined`
// (EISDIR gaudomas), ne išimtį.
//
// `readStdin` čia tikrinamas TIK forma. Jis prikabina `process.stdin` klausytojus ir laukia EOF,
// kurio `node --test` procese niekada nebūna — jo kvietimas pakabintų visą rinkinį.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { preHookPorts } from "../composition/hooks/pre-adapters.js";
import {
  migrationGuardPorts,
  packageGuardPorts,
  postWriteGuardPorts,
  scopeGuardPorts,
  secretScanPorts,
} from "../composition/hooks/guard-adapters.js";
import {
  collectKnownTaskIds,
  detectGuardRoots,
  hookBackendGuard,
  hookMigrationGuard,
  hookPackageGuard,
  hookSecretScan,
  runPostWriteGuards,
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

/**
 * `HookFsPort` konformanso kontraktas — vienas vardas visam tam, ką portas PRIVALO daryti
 * lygiai taip, kaip `nodeFsAdapter`.
 *
 * Kiekvienas teiginys čia yra tos pačios formos: „realus adapteris elgiasi TAIP", o ne „mums
 * patogu, kad būtų taip". Task 238 fake'ai turi atkartoti būtent šį sąrašą.
 */
async function assertHookFsBehavesLikeNodeAdapter(fs: HookFsPort, root: string, label: string): Promise<void> {
  // `exists` mato ir katalogus, ne tik failus (fake'as čia dreifuoja: jis turi tik failų mapą).
  assert.equal(await fs.exists(root), true, `${label}: exists(katalogas) → true`);
  assert.equal(await fs.exists(path.join(root, "nera-tokio")), false, `${label}: exists(nėra) → false`);

  // `makeDirectory` kuria REKURSYVIAI (mkdir -p), o ne vieną lygį, ir yra idempotentiškas.
  const deep = path.join(root, "a", "b", "c");
  await fs.makeDirectory(deep);
  assert.equal(await fs.exists(deep), true, `${label}: makeDirectory rekursyvus`);
  await fs.makeDirectory(deep);

  assert.equal(
    await fs.readTextFileIfExists(path.join(root, "nera-tokio.txt")),
    undefined,
    `${label}: readTextFileIfExists trūkstamam → undefined`,
  );

  // FAKTAS: rašymas į NEEGZISTUOJANTĮ katalogą pavyksta — `writeTextFile` pats daro `mkdir -p`.
  const nested = path.join(root, "x", "y", "z.txt");
  await fs.writeTextFile(nested, "pirmas\n");
  assert.equal(await fs.readTextFileIfExists(nested), "pirmas\n", `${label}: writeTextFile kuria tėvus`);
  await fs.writeTextFile(nested, "antras\n");
  assert.equal(await fs.readTextFileIfExists(nested), "antras\n", `${label}: writeTextFile perrašo`);

  // Tas pats `appendTextFile` pusėje, ir jis PRIDEDA, o ne perrašo.
  const appended = path.join(root, "p", "q", "log.txt");
  await fs.appendTextFile(appended, "a\n");
  await fs.appendTextFile(appended, "b\n");
  assert.equal(await fs.readTextFileIfExists(appended), "a\nb\n", `${label}: appendTextFile kuria tėvus ir prideda`);

  // KLAIDŲ KLASĖ: katalogas kaip failas. `readTextFileIfExists` gaudo EISDIR/ENOTDIR ir grąžina
  // `undefined` — NEMETA. Kelias PER failą (ENOTDIR) duoda tą patį.
  assert.equal(await fs.readTextFileIfExists(deep), undefined, `${label}: readTextFileIfExists(katalogas) → undefined`);
  assert.equal(
    await fs.readTextFileIfExists(path.join(nested, "toliau.txt")),
    undefined,
    `${label}: readTextFileIfExists(kelias per failą) → undefined`,
  );

  // EACCES netikrinamas sąmoningai: win32 `chmod` skaitymo teisių nevaldo, tad testas būtų arba
  // tuščias, arba platformai specifinis. EISDIR/ENOTDIR yra deterministiniai abiejose.
}

// ---------------------------------------------------------------------------
// preHookPorts
// ---------------------------------------------------------------------------

test("preHookPorts: fs portas elgiasi lygiai kaip nodeFsAdapter", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-pre-fs-");
  await assertHookFsBehavesLikeNodeAdapter(preHookPorts(runtimeRoot).fs, projectRoot, "preHookPorts.fs");
});

test("preHookPorts: listDirectoryIfExists surištas ir grąžina failus IR katalogus", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-pre-list-");

  // Laukas NEPRIVALOMAS `HookFsPort` tipe, tad jo pametimas būtų tyli regresija: kompiliatorius
  // tylėtų, o `collectKnownTaskIds` nusileistų iki ledger'io. Todėl — runtime patikra.
  const fs = preHookPorts(runtimeRoot).fs;
  assert.equal(
    typeof fs.listDirectoryIfExists,
    "function",
    "preHookPorts.fs.listDirectoryIfExists privalo būti surištas",
  );

  await nodeFsAdapter.writeTextFile(path.join(projectRoot, "mixed", "failas.md"), "x\n");
  await nodeFsAdapter.makeDirectory(path.join(projectRoot, "mixed", "pokatalogis"));

  const entries = await fs.listDirectoryIfExists?.(path.join(projectRoot, "mixed"));
  assert.deepEqual([...(entries ?? [])].sort(), ["failas.md", "pokatalogis"], "įrašai: ir failas, ir katalogas");
  assert.equal(
    await fs.listDirectoryIfExists?.(path.join(projectRoot, "nera")),
    undefined,
    "nesamas katalogas → undefined",
  );
});

test("preHookPorts: collectKnownTaskIds per realų portą mato VISUS bucket'us ir ledger'į", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-pre-ids-");

  await nodeFsAdapter.writeTextFile(path.join(projectRoot, "AG", "tasks", "queue", "301-eileje.md"), "# 301\n");
  await nodeFsAdapter.writeTextFile(path.join(projectRoot, "AG", "tasks", "done", "302-baigta.md"), "# 302\n");
  await nodeFsAdapter.writeTextFile(
    path.join(projectRoot, "AG", "tasks", "human-review", "303-tranzitas.md"),
    "# 303\n",
  );
  await nodeFsAdapter.writeTextFile(
    path.join(runtimeRoot, "state", "task-ledger.json"),
    JSON.stringify({ "304-tik-ledgeryje": { state: "done" } }),
  );

  const ids = await collectKnownTaskIds(preHookPorts(runtimeRoot).fs, projectRoot, runtimeRoot);
  for (const id of ["301-eileje", "302-baigta", "303-tranzitas", "304-tik-ledgeryje"]) {
    assert.ok(ids.includes(id), `${id} privalo patekti į žinomų id aibę`);
  }
});

test("preHookPorts: nuosavybės, profilio ir komandų portai surišti su realia šaknimi", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-pre-own-");
  const ports = preHookPorts(runtimeRoot);

  // `pathIsTaken` remiasi `lstat`: egzistuojantis failas UŽIMTAS, nesamas — ne.
  const taken = path.join(projectRoot, "uzimta.txt");
  await writeFile(taken, "x\n", "utf8");
  assert.equal(await ports.pathIsTaken(taken), true);
  assert.equal(await ports.pathIsTaken(path.join(projectRoot, "laisva.txt")), false);

  // `resolveDeepestRealPath` dar nesukurtam keliui išsaugo uodegą už egzistuojančio protėvio.
  const resolved = await ports.resolveDeepestRealPath(path.join(projectRoot, "nauja", "gili.txt"));
  assert.ok(resolved.endsWith(path.join("nauja", "gili.txt")), `uodega išsaugota: ${resolved}`);

  // Tuščias projektas: nė vieno gyvo lease'o, ir tai NE klaida.
  assert.deepEqual(await ports.liveLeaseWorktreePaths(projectRoot), []);

  const runtimeAuthority = await ports.authorizeWorkerRuntimeMutation({ projectRoot });
  assert.equal(typeof runtimeAuthority.ok, "boolean", "authorizeWorkerRuntimeMutation grąžina verdiktą");
  const scopeAuthority = await ports.authorizeScopedWrite({ projectRoot, repoRelativePath: "src/demo.ts" });
  assert.equal(typeof scopeAuthority.ok, "boolean", "authorizeScopedWrite grąžina verdiktą");

  // Profilis: nėra → undefined; sugadintas → undefined; validus → objektas.
  assert.equal(await ports.loadProjectProfile(projectRoot), undefined, "nesamas profilis → undefined");
  const profilePath = path.join(runtimeRoot, "project", "profile.json");
  await nodeFsAdapter.writeTextFile(profilePath, "{ne json");
  assert.equal(await ports.loadProjectProfile(projectRoot), undefined, "sugadintas profilis → undefined");
  await nodeFsAdapter.writeTextFile(profilePath, JSON.stringify({ source_roots: ["apps/web"] }));
  assert.deepEqual((await ports.loadProjectProfile(projectRoot))?.source_roots, ["apps/web"]);

  // Politikos nėra — kontekstas privalo grįžti objektu, ne išimtimi (fail-safe = fail-closed).
  const commandContext = await ports.checkCommandContext(projectRoot);
  assert.equal(typeof commandContext, "object", "checkCommandContext be politikos nemeta");
  assert.notEqual(commandContext, null);

  // Forma be kvietimo: `readStdin` čia paleisti negalima (žr. failo antraštę).
  assert.equal(typeof ports.stdin.readStdin, "function");
});

test("preHookPorts: appendHookLog rašo į <runtimeRoot>/logs/hooks.log ir nurija savo klaidą", async () => {
  const { runtimeRoot } = await makeProject("vq-pre-log-");
  await preHookPorts(runtimeRoot).appendHookLog("vartų eilutė");
  assert.equal(await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "logs", "hooks.log")), "vartų eilutė\n");

  // Žurnalas NĖRA sprendimo dalis: kai `logs` yra FAILAS, `mkdir` krenta ENOTDIR, o portas
  // privalo tylėti — kitaip vartai blokuotų dėl savo pačių telemetrijos.
  const { runtimeRoot: brokenRoot } = await makeProject("vq-pre-log-broken-");
  await nodeFsAdapter.writeTextFile(path.join(brokenRoot, "logs"), "ne katalogas\n");
  await preHookPorts(brokenRoot).appendHookLog("neįrašoma");
});

// ---------------------------------------------------------------------------
// guard portai
// ---------------------------------------------------------------------------

test("guard portai: visų penkių fs elgiasi kaip nodeFsAdapter", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-guard-fs-");
  const factories = [
    ["secretScanPorts", secretScanPorts(runtimeRoot).fs],
    ["packageGuardPorts", packageGuardPorts(runtimeRoot).fs],
    ["migrationGuardPorts", migrationGuardPorts(runtimeRoot).fs],
    ["postWriteGuardPorts", postWriteGuardPorts(runtimeRoot).fs],
    ["scopeGuardPorts", scopeGuardPorts(runtimeRoot).fs],
  ] as const;

  for (const [label, fs] of factories) {
    const sandbox = path.join(projectRoot, label);
    await nodeFsAdapter.makeDirectory(sandbox);
    await assertHookFsBehavesLikeNodeAdapter(fs, sandbox, `${label}.fs`);
  }
});

test("secretScanPorts: end-to-end blokavimas per realų fs — radinys atsiranda diske", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-secret-");

  // Raktas surenkamas RUNTIME metu: šaltinyje jis lieka `AKIA${…}`, tad šis failas pats nenudažo
  // repo secret-scan vartų raudonai (2026-09-05 pamoka apie komentarų placeholder'ius).
  const secretLine = `const key = "AKIA${"Q7X4M2N9P1R5T8V3"}";`;
  await nodeFsAdapter.writeTextFile(path.join(projectRoot, "src", "leak.ts"), `${secretLine}\n`);
  // Ne git repo: vienintelis pakeitimų šaltinis yra `changes.log`, kurį rašo PostToolUse hook'as.
  await nodeFsAdapter.writeTextFile(
    path.join(runtimeRoot, "logs", "changes.log"),
    "[2026-09-05T00:00:00.000Z] MODIFIED: src/leak.ts\n",
  );

  const { io, lines } = captureIo();
  const code = await hookSecretScan({ ports: secretScanPorts(runtimeRoot), projectRoot, runtimeRoot, io });

  assert.equal(code, 1, "rastas slaptukas privalo blokuoti");
  const findings = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "logs", "secret-scan.log"));
  assert.ok(findings?.includes("src/leak.ts:1:possible-secret:aws-access-key"), `radinių žurnalas: ${findings}`);
  assert.ok(
    lines.some((line) => line.includes("secret-scan.log")),
    "operatorius nukreipiamas į radinių žurnalą",
  );
});

test("secretScanPorts: be security-policy.json skenavimas ĮJUNGTAS (fail-closed)", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-secret-policy-");
  const ports = secretScanPorts(runtimeRoot);
  assert.equal(await ports.secretScanEnabled(projectRoot), true, "trūkstama politika negali išjungti skenerio");
  // Ne git kataloge git skaitymai privalo virsti tuščiais duomenimis, ne išimtimi.
  assert.deepEqual(await ports.collectChangedFiles(projectRoot), []);
  assert.equal((await ports.filterGitIgnored(["src/a.ts"], projectRoot)).has("src/a.ts"), false);
});

test("packageGuardPorts: end-to-end per realų fs — žurnalai atsiranda, git skaitymai nemeta", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-package-");
  const ports = packageGuardPorts(runtimeRoot);

  assert.equal(await ports.isGitRepository(projectRoot), false, "tmp katalogas nėra git repo");
  assert.deepEqual(await ports.packageJsonDiffLines(projectRoot), [], "ne git repo → tuščias diff");
  assert.deepEqual(await ports.collectChangedFilesWithStatus(projectRoot), []);
  assert.equal(await ports.loadProjectProfile(projectRoot), undefined, "nesamas profilis → undefined");
  assert.equal(typeof ports.env, "function", "tapatybė ateina TIK per aplinką");

  const { io } = captureIo();
  const code = await hookPackageGuard({ ports, projectRoot, runtimeRoot, io });
  assert.equal(code, 0, "be package pakeitimų guard'as praleidžia");
  assert.equal(await nodeFsAdapter.exists(path.join(runtimeRoot, "logs", "package-guard.log")), true);
  const hooksLog = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "logs", "hooks.log"));
  assert.ok(hooksLog?.includes("Package guard"), `hooks.log: ${hooksLog}`);
});

test("migrationGuardPorts: end-to-end per realų fs — praleidimas užrašomas diske", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-migration-");
  const ports = migrationGuardPorts(runtimeRoot);

  assert.deepEqual(await ports.stagedNameStatusLines(projectRoot), [], "ne git repo → tuščios eilutės");
  assert.deepEqual(await ports.packageJsonDiffLines(projectRoot), []);

  const { io } = captureIo();
  const code = await hookMigrationGuard({ ports, projectRoot, runtimeRoot, io });
  assert.equal(code, 0, "migracijų nekeista → 0");
  assert.equal(await nodeFsAdapter.exists(path.join(runtimeRoot, "logs", "migration-guard.log")), true);
  const hooksLog = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "logs", "hooks.log"));
  assert.ok(hooksLog?.includes("Migration guard praleistas"), `hooks.log: ${hooksLog}`);
});

test("postWriteGuardPorts: guardRoots seka profilį, detectGuardRoots — realų diską", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-postwrite-");

  // Be profilio — pnpm triados numatytieji.
  assert.deepEqual(await postWriteGuardPorts(runtimeRoot).guardRoots(projectRoot), {
    frontend: "apps/web",
    backend: "apps/api",
    mobile: "apps/mobile",
  });

  await nodeFsAdapter.writeTextFile(
    path.join(runtimeRoot, "project", "profile.json"),
    JSON.stringify({ source_roots: ["packages/api", "packages/web"] }),
  );
  const ports = postWriteGuardPorts(runtimeRoot);
  assert.deepEqual(await ports.guardRoots(projectRoot), {
    frontend: "packages/web",
    backend: "packages/api",
    mobile: "apps/mobile",
  });

  // `detectGuardRoots` klausia to paties fs porto: sukurtas katalogas → true, nesukurtas → false.
  await nodeFsAdapter.makeDirectory(path.join(projectRoot, "packages", "api"));
  assert.deepEqual(await detectGuardRoots(ports, projectRoot), { frontend: false, backend: true, mobile: false });
});

test("postWriteGuardPorts: runGuard krentantį vaiką grąžina KODU, o ne išimtimi", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-runguard-");
  const ports = postWriteGuardPorts(runtimeRoot);

  // Vienas realus vaikinis procesas visam failui: CLI nežinomos komandos nepriima ir baigiasi
  // ne nuliu. Kontraktas, kurį tai pin'ina — `result?.code ?? 1`, t. y. NIEKADA ne išimtis.
  const code = await ports.runGuard("hook-tokios-komandos-nera", [], projectRoot);
  assert.equal(typeof code, "number", "runGuard PRIVALO grąžinti kodą, ne mesti");
  assert.notEqual(code, 0, "nežinoma komanda negali atrodyti kaip sėkmė");

  // Fan-out'as neblokuoja NIEKADA; `guards: []` laiko šį atvejį be papildomų subprocesų (pats
  // filtras patikrintas `detectGuardRoots` pusėje).
  assert.equal(await runPostWriteGuards({ ports, projectRoot, runtimeRoot, guards: [] }), 0);
});

test("scopeGuardPorts: guardRoots, commandExists ir end-to-end backend guard per realų fs", async () => {
  const { projectRoot, runtimeRoot } = await makeProject("vq-scope-");
  const ports = scopeGuardPorts(runtimeRoot);

  assert.equal((await ports.guardRoots(projectRoot)).backend, "apps/api");
  assert.equal(await ports.commandExists("tokios-komandos-tikrai-nera-vq"), false, "nesama komanda → false, ne klaida");
  // `runShell` netikrinamas kvietimu: jis paleidžia laisvos formos komandą, o šis rinkinys
  // subprocesų neveisia (žr. `runGuard` — vienas realus vaikas visam failui).
  assert.equal(typeof ports.runShell, "function");

  const { io } = captureIo();
  const code = await hookBackendGuard({ ports, projectRoot, runtimeRoot, io });
  assert.equal(code, 0, "backend failų nekeista → 0");
  const guardLog = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "logs", "backend-guard.log"));
  assert.ok(guardLog?.startsWith("skipped:"), `backend-guard.log: ${guardLog}`);
});
