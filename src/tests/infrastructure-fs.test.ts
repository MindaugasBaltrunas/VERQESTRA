// NodeFsAdapter integraciniai testai (E4 VQ-401) — REALI failų sistema laikinuose
// kataloguose (infrastruktūros testams tai leidžiama; E3 fake-port testai lieka atskirai).

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createCodeIntelligenceFsAdapter } from "../infrastructure/fs/code-intelligence-fs-adapter.js";
import { createProjectContainment } from "../infrastructure/fs/project-containment.js";
import { initProgress, updateNodeProgress } from "../infrastructure/bootstrap/architecture-graph-store.js";
import { computeArchitectureGraphHash } from "../domain/architecture/graph-hash.js";
import type {
  ArchitectureGraph,
  ArchitectureNodeProgress,
  ArchitectureProgress,
} from "../domain/architecture/index.js";
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
test("createCodeIntelligenceFsAdapter: symlink'as už šaknies neperskaitomas (realpath vartas)", async () => {
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

    // JUNCTION, ne failo symlink'as: Windows'e failo symlink'ui reikia Developer Mode arba
    // admin teisių, o katalogo junction'ui — ne. Vartui klausimas identiškas: `realpath`
    // išveda kelią UŽ šaknies. Anksčiau ši šaka šioje mašinoje buvo PRALEIDŽIAMA, tad
    // guard'as likdavo nepatikrintas būtent ten, kur jis svarbiausias.
    await symlink(outside, path.join(projectRoot, "nuoroda"), "junction");

    await assert.rejects(
      () => fs.readTextFile(path.join(projectRoot, "nuoroda", "slaptas.md")),
      /escapes project root/,
    );
    assert.equal(
      await fs.statKind(path.join(projectRoot, "nuoroda", "slaptas.md")),
      "absent",
      "už ribų rodančios nuorodos egzistavimas nėra informacija, kurią portas turi teisę atskleisti",
    );

    // RAŠYMO kelias per symlink'intą TĖVĄ. Taikinio dar nėra, tad jo paties `realpath` krenta —
    // anksčiau patikra tada būdavo praleidžiama ir rašymas nukeliaudavo už šaknies. Tikrinamas
    // giliausias EGZISTUOJANTIS protėvis, tad nuoroda pagaunama nesukūrus nė vieno baito.
    await symlink(outside, path.join(projectRoot, "isorinis"), "junction");
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
test("createProjectContainment: symlink'as projekto viduje neatiduoda išorinio turinio", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-slice-link-in-"));
  const outside = await mkdtemp(path.join(tmpdir(), "vq-slice-link-out-"));
  try {
    await writeFile(path.join(outside, "svetimas.ts"), "svetimas kodas\n", "utf8");
    // Junction dėl tos pačios priežasties kaip aukščiau; taikinys pasiekiamas per jį.
    await symlink(outside, path.join(projectRoot, "atrodo-vidinis"), "junction");

    const containment = createProjectContainment(projectRoot);
    // Leksiškai kelias yra projekto VIDUJE — būtent todėl vien leksinio varto neužtenka.
    assert.equal(
      await containment.containedOrUndefined(path.join(projectRoot, "atrodo-vidinis", "svetimas.ts")),
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

// Prarasto atnaujinimo atkūrimas: du „workeriai" vienu metu baigia SKIRTINGUS mazgus. Be lock'o
// abu perskaito tą pačią pradinę būseną, ir vėlesnis rašymas ištrina ankstesniojo rezultatą —
// atkurta būsena buvo `A=planned, B=done`. Testas tikrina BŪTENT tai, ko nebuvo: kad išlieka ABU.
test("architecture progress: lygiagretūs skirtingų mazgų atnaujinimai neprarandami", async () => {
  const statePath = p("arch", "progress.json");
  const node = (): ArchitectureNodeProgress => ({
    status: "planned",
    attempts: {},
    queued_tasks: [],
    done_tasks: [],
    implemented_files: [],
    evidence_refs: [],
  });
  await nodeFsAdapter.writeTextFile(
    statePath,
    JSON.stringify({ graph_hash: "h", nodes: { A: node(), B: node() } }, null, 2),
  );

  // Startuoja kartu — ne nuosekliai; be mutex'o abu perskaitytų `A=planned, B=planned`.
  await Promise.all([
    updateNodeProgress(statePath, "A", { status: "done" }),
    updateNodeProgress(statePath, "B", { status: "done" }),
  ]);

  const after = JSON.parse(await nodeFsAdapter.readTextFile(statePath)) as ArchitectureProgress;
  assert.equal(after.nodes["A"]?.status, "done", "pirmojo rašytojo rezultatas neperrašytas");
  assert.equal(after.nodes["B"]?.status, "done");
  // Lock'as atlaisvinamas — kitaip kitas rašytojas lauktų iki stale ribos.
  assert.equal(await nodeFsAdapter.exists(`${statePath}.lock`), false, "lock katalogas nepaliktas");
});

// `done` yra teiginys apie KONKRETŲ darbo vienetą. Anksčiau refresh'as jį išsaugodavo vien pagal
// ID, tad pasikeitus etiketei ar briaunoms mazgas likdavo `done` su senais `implemented_files` ir
// atrakindavo downstream. ID yra tik vardas, ne tapatybė.
test("architecture progress: pasikeitęs mazgo apibrėžimas nebepaveldi `done`", async () => {
  const statePath = p("arch-refresh", "progress.json");
  const graph = (label: string): ArchitectureGraph => ({
    source_path: "s.mmd",
    imported_at: "2026-08-21T00:00:00.000Z",
    nodes: [
      { id: "A", label, kind: "component", status: "planned" },
      { id: "B", label: "Stabilus", kind: "component", status: "planned" },
    ],
    edges: [],
  });

  const first = await initProgress(graph("Parseris"), statePath);
  assert.match(first.graph_hash, /^ag1:[0-9a-f]{16}$/, "graph_hash yra TURINIO atspaudas, ne laiko žyma");

  // Abu mazgai užbaigiami.
  await updateNodeProgress(statePath, "A", { status: "done", implemented_files: ["src/a.ts"] });
  await updateNodeProgress(statePath, "B", { status: "done", implemented_files: ["src/b.ts"] });

  // Grafas perimportuojamas: A etiketė pasikeitė, B — ne.
  const refreshed = await initProgress(graph("Visai kitas komponentas"), statePath);
  assert.equal(refreshed.nodes["A"]?.status, "human-review", "pakeistas mazgas nebelieka `done`");
  assert.match(refreshed.nodes["A"]?.human_review_reason ?? "", /definition changed/);
  assert.deepEqual(
    refreshed.nodes["A"]?.implemented_files,
    ["src/a.ts"],
    "evidencija IŠSAUGOMA — jos operatoriui reikia sprendžiant, ar darbas vis dar tinka",
  );
  assert.equal(refreshed.nodes["B"]?.status, "done", "nepakitęs mazgas lieka `done`");

  // Tas pats grafas antrą kartą — hash'as NEsikeičia, nors `imported_at` būtų kitoks.
  assert.equal(
    computeArchitectureGraphHash({ ...graph("Visai kitas komponentas"), imported_at: "2027-01-01T00:00:00.000Z" }),
    refreshed.graph_hash,
    "provenencija (imported_at) į turinio atspaudą nepatenka",
  );
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
