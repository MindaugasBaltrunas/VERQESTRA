// NodeFsAdapter integraciniai testai (E4 VQ-401) — REALI failų sistema laikinuose
// kataloguose (infrastruktūros testams tai leidžiama; E3 fake-port testai lieka atskirai).

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createCodeIntelligenceFsAdapter } from "../infrastructure/fs/code-intelligence-fs-adapter.js";
import { createProjectContainment } from "../infrastructure/fs/project-containment.js";
import { isWin32ContentionError, withWin32RenameRetry } from "../infrastructure/fs/fs-retry.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";

const root = await mkdtemp(path.join(tmpdir(), "vq-fs-"));
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const p = (...segments: string[]): string => path.join(root, ...segments);

// Leksinis vartas symlink'o iš principo nemato, tad jis privalo būti čia — vietoje, kuri
// liečia diską. Be jo nuoroda, guli projekto viduje ir rodanti į išorę, tyliai ištrauktų
// svetimą turinį į LLM promptą ir į context cache.
test("createCodeIntelligenceFsAdapter: symlink'as už šaknies neperskaitomas (realpath vartas)", async (t) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-contain-in-"));
  const outside = await mkdtemp(path.join(tmpdir(), "vq-contain-out-"));
  try {
    await writeFile(path.join(projectRoot, "vidus.md"), "vidinis\n", "utf8");
    await writeFile(path.join(outside, "slaptas.md"), "svetimas\n", "utf8");

    const fs = createCodeIntelligenceFsAdapter(projectRoot);
    assert.equal(await fs.readTextFile(path.join(projectRoot, "vidus.md")), "vidinis\n");

    // Tiesioginis kelias už ribų krenta jau leksiškai — be jokio disko lietimo.
    await assert.rejects(() => fs.readTextFile(path.join(outside, "slaptas.md")), /escapes project root/);
    assert.equal(await fs.statKind(path.join(outside, "slaptas.md")), "absent");
    assert.equal(await fs.exists(path.join(outside, "slaptas.md")), false);

    // Symlink'ui Windows'e reikia Developer Mode arba admin teisių; kur jo sukurti negalima,
    // testas praleidžiamas SĄMONINGAI, o ne apsimeta žaliu.
    try {
      await symlink(path.join(outside, "slaptas.md"), path.join(projectRoot, "nuoroda.md"), "file");
    } catch {
      t.skip("symlink kūrimas neleidžiamas šioje aplinkoje");
      return;
    }

    await assert.rejects(() => fs.readTextFile(path.join(projectRoot, "nuoroda.md")), /escapes project root/);
    assert.equal(
      await fs.statKind(path.join(projectRoot, "nuoroda.md")),
      "absent",
      "už ribų rodančios nuorodos egzistavimas nėra informacija, kurią portas turi teisę atskleisti",
    );

    // RAŠYMO kelias per symlink'intą TĖVĄ. Taikinio dar nėra, tad jo paties `realpath` krenta —
    // anksčiau patikra tada būdavo praleidžiama ir rašymas nukeliaudavo už šaknies. Tikrinamas
    // giliausias EGZISTUOJANTIS protėvis, tad nuoroda pagaunama nesukūrus nė vieno baito.
    try {
      await symlink(outside, path.join(projectRoot, "isorinis"), "dir");
    } catch {
      t.skip("katalogo symlink'o kūrimas neleidžiamas šioje aplinkoje");
      return;
    }
    const throughLink = path.join(projectRoot, "isorinis", "naujas.md");
    await assert.rejects(() => fs.writeTextFileAtomic(throughLink, "neturi patekti"), /escapes project root/);
    await assert.rejects(
      () => fs.makeDirectory(path.join(projectRoot, "isorinis", "naujas-katalogas")),
      /escapes project root/,
    );
    assert.equal(
      await nodeFsAdapter.exists(path.join(outside, "naujas.md")),
      false,
      "už projekto ribų neatsirado nė vieno failo",
    );

    // Ir kontrolinis atvejis: naujas failas TIKRAME projekto viduje rašomas normaliai — vartas
    // neturi teisės blokuoti dar nesukurtų kelių vien dėl to, kad jų nėra.
    await fs.writeTextFileAtomic(path.join(projectRoot, "gilus", "naujas.md"), "vidinis");
    assert.equal(await fs.readTextFile(path.join(projectRoot, "gilus", "naujas.md")), "vidinis");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// Leksinis vartas `staleSourceSlices` viduje symlink'o nemato — tai porto realizacijos darbas.
// Čia tikrinama būtent ta pusė: projekto viduje gulinti nuoroda į išorę per containment
// nepraeina, tad šviežumo skaičiuotojas jos turinio negauna ir kelias lieka „pasenęs".
test("createProjectContainment: symlink'as projekto viduje neatiduoda išorinio turinio", async (t) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-slice-link-in-"));
  const outside = await mkdtemp(path.join(tmpdir(), "vq-slice-link-out-"));
  try {
    await writeFile(path.join(outside, "svetimas.ts"), "svetimas kodas\n", "utf8");
    try {
      await symlink(path.join(outside, "svetimas.ts"), path.join(projectRoot, "atrodo-vidinis.ts"), "file");
    } catch {
      t.skip("symlink kūrimas neleidžiamas šioje aplinkoje");
      return;
    }

    const containment = createProjectContainment(projectRoot);
    // Leksiškai kelias yra projekto VIDUJE — būtent todėl vien leksinio varto neužtenka.
    assert.equal(
      await containment.containedOrUndefined(path.join(projectRoot, "atrodo-vidinis.ts")),
      undefined,
      "realpath vartas pagauna nuorodą, kurios leksinis nemato",
    );
    assert.notEqual(
      await containment.containedOrUndefined(path.join(projectRoot, "tikras.ts")),
      undefined,
      "paprastas vidinis kelias praeina",
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("writeTextFile: atominis, kuria tėvinius katalogus ir nepalieka tmp šiukšlių", async () => {
  await nodeFsAdapter.writeTextFile(p("deep", "nested", "a.json"), '{"x":1}');
  assert.equal(await nodeFsAdapter.readTextFile(p("deep", "nested", "a.json")), '{"x":1}');
  const leftovers = (await readdir(p("deep", "nested"))).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("readTextFileIfExists: RAW be trim; nesamas failas ir katalogas — undefined", async () => {
  await nodeFsAdapter.writeTextFile(p("raw.txt"), "  turinys su kraštais \n");
  assert.equal(await nodeFsAdapter.readTextFileIfExists(p("raw.txt")), "  turinys su kraštais \n");
  assert.equal(await nodeFsAdapter.readTextFileIfExists(p("nėra.txt")), undefined);
  await nodeFsAdapter.makeDirectory(p("katalogas"));
  assert.equal(await nodeFsAdapter.readTextFileIfExists(p("katalogas")), undefined);
});

test("writeFileExclusive: wx semantika — created, tada exists be perrašymo", async () => {
  assert.equal(await nodeFsAdapter.writeFileExclusive(p("wx", "once.md"), "pirmas"), "created");
  assert.equal(await nodeFsAdapter.writeFileExclusive(p("wx", "once.md"), "antras"), "exists");
  assert.equal(await nodeFsAdapter.readTextFile(p("wx", "once.md")), "pirmas");
});

test("appendTextFile kuria tėvą ir append'ina; statPath/statKind atskiria rūšis", async () => {
  await nodeFsAdapter.appendTextFile(p("logs", "x.jsonl"), "a\n");
  await nodeFsAdapter.appendTextFile(p("logs", "x.jsonl"), "b\n");
  assert.equal(await nodeFsAdapter.readTextFile(p("logs", "x.jsonl")), "a\nb\n");

  const fileStat = await nodeFsAdapter.statPath(p("logs", "x.jsonl"));
  assert.equal(fileStat.kind, "file");
  assert.equal(fileStat.size, 4);
  assert.deepEqual(await nodeFsAdapter.statPath(p("logs")), { kind: "directory", size: 0 });
  assert.deepEqual(await nodeFsAdapter.statPath(p("nėra")), { kind: "absent", size: 0 });
  assert.equal(await nodeFsAdapter.statKind(p("logs")), "directory");
  assert.equal(await nodeFsAdapter.statKind(p("logs", "x.jsonl")), "file");
  assert.equal(await nodeFsAdapter.statKind(p("nėra")), "absent");
});

test("list*: rūšiuoti vardai; nesamas katalogas — [] arba undefined pagal kontraktą", async () => {
  await nodeFsAdapter.writeTextFile(p("sąrašas", "b.md"), "b");
  await nodeFsAdapter.writeTextFile(p("sąrašas", "a.md"), "a");
  await nodeFsAdapter.writeTextFile(p("sąrašas", "c.txt"), "c");
  await nodeFsAdapter.makeDirectory(p("sąrašas", "vidus"));

  assert.deepEqual(await nodeFsAdapter.listFiles(p("sąrašas")), ["a.md", "b.md", "c.txt"]);
  assert.deepEqual(await nodeFsAdapter.listSubdirectories(p("sąrašas")), ["vidus"]);
  assert.deepEqual(await nodeFsAdapter.listDirectory(p("sąrašas")), ["a.md", "b.md", "c.txt", "vidus"]);
  assert.deepEqual(
    await nodeFsAdapter.listMarkdownFiles(p("sąrašas")),
    [p("sąrašas", "a.md"), p("sąrašas", "b.md")],
  );
  assert.deepEqual(await nodeFsAdapter.listFiles(p("nėra")), []);
  assert.equal(await nodeFsAdapter.listDirectoryIfExists(p("nėra")), undefined);
});

test("newestMtime ir newestMtimeInDir renka naujausią žymą per medį", async () => {
  await nodeFsAdapter.writeTextFile(p("mtime", "senas.txt"), "1");
  await nodeFsAdapter.writeTextFile(p("mtime", "gilyn", "naujas.txt"), "2");
  // utimes su Date: mtimeMs atitinka Date reikšmę milisekundėmis.
  await utimes(p("mtime", "senas.txt"), new Date(1_000_000), new Date(1_000_000));
  await utimes(p("mtime", "gilyn", "naujas.txt"), new Date(2_000_000), new Date(2_000_000));

  const flat = await nodeFsAdapter.newestMtime([p("mtime", "senas.txt"), p("nėra.txt")]);
  assert.equal(flat, 1_000_000);
  const tree = await nodeFsAdapter.newestMtimeInDir(p("mtime"));
  assert.equal(tree, 2_000_000);
  assert.equal(await nodeFsAdapter.newestMtimeInDir(p("nėra")), undefined);
});

test("createLockDirectory: mkdir be recursive — created, tada exists; removeDirectory išvalo", async () => {
  await nodeFsAdapter.makeDirectory(p("locks"));
  assert.equal(await nodeFsAdapter.createLockDirectory(p("locks", "l1")), "created");
  assert.equal(await nodeFsAdapter.createLockDirectory(p("locks", "l1")), "exists");
  assert.equal(typeof (await nodeFsAdapter.directoryModifiedAtMs(p("locks", "l1"))), "number");
  await nodeFsAdapter.removeDirectory(p("locks", "l1"));
  assert.equal(await nodeFsAdapter.exists(p("locks", "l1")), false);
});

test("withWin32RenameRetry: win32 contention kartojama, POSIX EPERM — ne", async () => {
  const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
  assert.equal(isWin32ContentionError(eperm, "win32"), true);
  assert.equal(isWin32ContentionError(eperm, "linux"), false);

  let attempts = 0;
  await withWin32RenameRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw eperm;
  }, "win32");
  assert.equal(attempts, 3);

  let posixAttempts = 0;
  await assert.rejects(
    () =>
      withWin32RenameRetry(async () => {
        posixAttempts += 1;
        throw eperm;
      }, "linux"),
    /EPERM/,
  );
  assert.equal(posixAttempts, 1);
});

test("readFileBytes grąžina baitus, o statPath dydis atitinka jų kiekį", async () => {
  await writeFile(p("bytes.bin"), Buffer.from([1, 2, 3]));
  const bytes = await nodeFsAdapter.readFileBytes(p("bytes.bin"));
  assert.equal(bytes.byteLength, 3);
  assert.equal((await nodeFsAdapter.statPath(p("bytes.bin"))).size, 3);
});
