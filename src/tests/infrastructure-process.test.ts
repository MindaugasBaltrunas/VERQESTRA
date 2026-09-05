// Spawn runner'io integraciniai testai (E4 VQ-401) — realūs Node vaikai per
// process.execPath (jokių shell priklausomybių, veikia visose platformose).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  helperKillTimeoutMs,
  isProcessAlive,
  runWindowsProcessTreeKill,
  treeKillMaxAttempts,
} from "../infrastructure/process/process-tree.js";
import {
  packageManagerExecutable,
  run,
  runWithInput,
  shellInvocationForPlatform,
  withSurvivorNote,
} from "../infrastructure/process/run-process.js";

const node = process.execPath;

test("run: exit kodas, stdout ir stderr surenkami atskirai", async () => {
  const result = await run(node, ["-e", "console.log('išvestis'); console.error('klaida'); process.exit(3)"]);
  assert.equal(result.code, 3);
  assert.match(result.stdout, /išvestis/);
  assert.match(result.stderr, /klaida/);
  assert.equal(result.stdoutTruncated, false);
});

test("run: timeout nužudo medį ir grąžina 124 su žinute", async () => {
  const result = await run(node, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 500 });
  assert.equal(result.code, 124);
  assert.match(result.stderr, /timed out after 1s|timed out after 0s/);
});

test("run: maxOutputBytes apkarpo head+tail su markeriu", async () => {
  const result = await run(node, ["-e", "process.stdout.write('x'.repeat(50000))"], { maxOutputBytes: 1000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.match(result.stdout, /\[stdout truncated; retained first 200 bytes and last 800 bytes\]/);
});

test("runWithInput: stdin paduodamas vaikui, onStdout stebi chunk'us", async () => {
  const seen: string[] = [];
  const result = await runWithInput(
    node,
    ["-e", "process.stdin.on('data', (d) => process.stdout.write(d))"],
    "labas per stdin",
    process.cwd(),
    undefined,
    undefined,
    { onStdout: (chunk) => seen.push(chunk.toString("utf8")) },
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /labas per stdin/);
  assert.match(seen.join(""), /labas per stdin/);
});

test("abort signalas nutraukia procesą su kvietėjo exit kodu ir priežastimi", async () => {
  const controller = new AbortController();
  const pending = run(node, ["-e", "setTimeout(() => {}, 30000)"], {
    abort: { signal: controller.signal, exitCode: 87, reason: "biudžetas išsemtas" },
  });
  setTimeout(() => controller.abort(), 200);
  const result = await pending;
  assert.equal(result.code, 87);
  assert.match(result.stderr, /biudžetas išsemtas/);
});

test("gryni pagalbininkai: shell invokacija pagal platformą ir .cmd priesaga", () => {
  assert.deepEqual(shellInvocationForPlatform("echo x", "linux"), { command: "sh", args: ["-lc", "echo x"] });
  assert.deepEqual(shellInvocationForPlatform("echo x", "win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "echo x"],
  });
  assert.equal(packageManagerExecutable("pnpm", "win32"), "pnpm.cmd");
  assert.equal(packageManagerExecutable("pnpm.CMD", "win32"), "pnpm.CMD");
  assert.equal(packageManagerExecutable("pnpm", "linux"), "pnpm");
  assert.throws(() => packageManagerExecutable("  "), /required/);
});

test("isProcessAlive: savas procesas gyvas", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

// 2026-08-24 (operatoriaus sprendimas): tree-kill verifikuoja VISĄ medį, ne tik root PID.
//
// Iki tol ciklas baigdavosi ties `!alive(rootPid)`, tad palikuonys likdavo nepatikrinti, o
// funkcija grįždavo tylia „sėkme" — agentas po timeout'o galėjo toliau suktis ir naudoti
// biudžetą. Sąrašas imamas PRIEŠ žudymą: mirus tėvui, vaikai persikabina ir apėjimas nuo root
// jų nebesuranda.
test("tree-kill: gyvas PALIKUONIS grąžinamas, o ne nutylimas", async () => {
  const ROOT = 4321;
  const CHILD = 4322;
  let attempts = 0;

  const survivors = await runWindowsProcessTreeKill(
    ROOT,
    () => {
      attempts += 1;
      return Promise.resolve(true);
    },
    // Root miršta iškart; vaikas išgyvena visus bandymus.
    (pid) => pid === CHILD,
    () => Promise.resolve([CHILD]),
  );

  assert.deepEqual(survivors, [CHILD], "likęs palikuonis privalo būti ĮVARDYTAS");
  assert.equal(attempts, treeKillMaxAttempts, "kartojama tol, kol lieka gyvų — ne tik dėl root");
});

test("tree-kill: miręs medis grąžina tuščią sąrašą ir nekartoja be reikalo", async () => {
  let attempts = 0;
  const survivors = await runWindowsProcessTreeKill(
    4321,
    () => {
      attempts += 1;
      return Promise.resolve(true);
    },
    () => false,
    () => Promise.resolve([4322, 4323]),
  );

  assert.deepEqual(survivors, []);
  assert.equal(attempts, 1, "pavykus pirmam bandymui, likusieji nebevykdomi");
});

test("tree-kill: nepavykęs medžio SĄRAŠAS nenutraukia žudymo — lieka bent root", async () => {
  // Tuščias sąrašas reiškia „medžio nežinome", ir tada verifikuojamas bent root — lygiai kaip
  // iki šio pakeitimo. Sąrašo klaida negali paversti žudymo klaida.
  const survivors = await runWindowsProcessTreeKill(
    4321,
    () => Promise.resolve(true),
    (pid) => pid === 4321,
    () => Promise.reject(new Error("WMI neprieinamas")),
  );
  assert.deepEqual(survivors, [4321]);
});

// 2026-09-05 (P2 F11): `alive(pid)` viena nepakankama — Windows pernaudoja PID'us greitai,
// tad "gyvas" palikuonio PID gali priklausyti visiškai kitam, vėliau paleistam procesui.
test("tree-kill: pernaudotas PID (alive, bet nebe medyje) nepatenka į survivors, tikras palikuonis — patenka", async () => {
  const ROOT = 4321;
  const REUSED = 4322;
  const REAL_SURVIVOR = 4323;
  let listCalls = 0;

  const survivors = await runWindowsProcessTreeKill(
    ROOT,
    () => Promise.resolve(true),
    // Abu PID'ai "gyvi" pagal process.kill patikrą — bet REUSED priklauso naujam procesui.
    (pid) => pid === REUSED || pid === REAL_SURVIVOR,
    // Pirmas kvietimas (prieš žudymą) dar mato REUSED kaip tikrą palikuonį. Po žudymo
    // REUSED procesas mirė, o jo PID'ą pernaudojo nesusijęs procesas — perskaičiuotame
    // medyje jo nebelieka, lieka tik tikras palikuonis.
    () => {
      listCalls += 1;
      return Promise.resolve(listCalls === 1 ? [REUSED, REAL_SURVIVOR] : [REAL_SURVIVOR]);
    },
  );

  assert.deepEqual(survivors, [REAL_SURVIVOR], "pernaudotas PID negali apsimesti likusiu palikuoniu");
});

// Re-listinimo NESĖKMĖ (WMI laikinai neprieinamas TARP bandymų) skiriasi nuo „medyje nieko
// nėra" — pirmoji reiškia „nežinome", antroji — „tikrai tuščia". Tikras gyvas palikuonis,
// žinomas iš pradinio sąrašo, negali dingti vien todėl, kad VIENAS re-list bandymas sugriuvo.
test("tree-kill: re-list nesėkmė TARP bandymų netampa tylia palikuonio mirtimi", async () => {
  const ROOT = 4321;
  const CHILD = 4322;

  const survivors = await runWindowsProcessTreeKill(
    ROOT,
    () => Promise.resolve(true),
    (pid) => pid === CHILD,
    // Pradinis sąrašas (prieš žudymą) pavyksta — CHILD žinomas. Kiekvienas VĖLESNIS
    // re-list bandymas (žudymo cikle) sugriūva.
    (_pid, timeoutMs) => (timeoutMs === helperKillTimeoutMs ? Promise.resolve([CHILD]) : Promise.reject(new Error("WMI"))),
  );

  assert.deepEqual(survivors, [CHILD], "re-list klaida negali nutylėti žinomo gyvo palikuonio");
});

test("withSurvivorNote: tuščias sąrašas žinutės nekeičia, likę — įvardijami", () => {
  assert.equal(withSurvivorNote("timeout", []), "timeout", "nieko neliko — nėra ko pranešti");
  assert.equal(withSurvivorNote(undefined, [7]), undefined, "nesant žinutės nėra ką papildyti");
  const noted = withSurvivorNote("timeout", [7, 9]);
  assert.match(noted ?? "", /2 process\(es\) still alive/);
  assert.match(noted ?? "", /7, 9/);
});
