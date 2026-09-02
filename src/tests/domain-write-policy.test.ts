// VQ-502 (3/6) testai — rašymo politikos grynosios taisyklės. Svarbiausia, ką jie pin'ina:
// traversal sutraukiamas PRIEŠ prefiksų atitikimą (kitaip `vq/tasks/../state/x.json` pralįstų),
// carve-out'ai prisegti prie šaknies (laisvas substring'as išjungtų vartus visam pomedžiui),
// o README-guard verdiktas nepriklauso nuo to, kurioje OS bėga hook'as.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED_ENV_TEMPLATE_BASENAMES,
  classifyForeignLeaseGuardScope,
  collapseTraversal,
  escapesRoot,
  evaluateReadmeGuardPolicy,
  evaluateWritePolicy,
  isMaintenancePath,
  normalizeForPolicy,
  normalizeReadEventPath,
  resolveReadmeGuardRequirements,
  DEFAULT_ARCHITECTURE_DOC,
  DEFAULT_README_GUARD_PATHS,
} from "../domain/policies/index.js";

// ---------------------------------------------------------------------------
// kelio normalizavimas
// ---------------------------------------------------------------------------

test("collapseTraversal: sutraukia . ir .., išsaugo diską bei vedančius ..", () => {
  assert.equal(collapseTraversal("vq/tasks/../state/x.json"), "vq/state/x.json");
  assert.equal(collapseTraversal("./a//b/./c"), "a/b/c");
  assert.equal(collapseTraversal("/repo/a/../b"), "/repo/b");
  assert.equal(collapseTraversal("D:/repo/a/../b"), "D:/repo/b");
  // Vedantys `..` paliekami, kad kvietėjas galėtų atmesti.
  assert.equal(collapseTraversal("../../x"), "../../x");
  assert.equal(escapesRoot("../x"), true);
  assert.equal(escapesRoot("a/../../x"), true);
  assert.equal(escapesRoot("a/../x"), false);
});

test("normalizeForPolicy visada lowercase, normalizeReadEventPath — tik drive keliams", () => {
  assert.equal(normalizeForPolicy("./VQ/State/X.json"), "vq/state/x.json");
  // Skaitymo įrodymo tapatybė nepriklauso nuo OS: repo-santykiniai keliai lieka case-sensitive.
  assert.equal(normalizeReadEventPath("./README.md"), "README.md");
  assert.equal(normalizeReadEventPath("D:/Repo/README.md"), "d:/repo/readme.md");
});

// ---------------------------------------------------------------------------
// evaluateWritePolicy
// ---------------------------------------------------------------------------

test("evaluateWritePolicy: paprastas produkto failas praeina", () => {
  assert.equal(evaluateWritePolicy("src/app/service.ts"), undefined);
  assert.equal(evaluateWritePolicy("docs/readme.md"), undefined);
});

test("evaluateWritePolicy: env/raktų failai blokuojami bet kokiu registru", () => {
  assert.equal(evaluateWritePolicy(".env")?.reason, "saugomas failas");
  assert.equal(evaluateWritePolicy("config/.ENV")?.reason, "saugomas failas");
  assert.equal(evaluateWritePolicy("config/.env.development")?.reason, "saugomas failas");
  assert.equal(evaluateWritePolicy("certs/server.PEM")?.reason, "saugomas pletinys");
  assert.equal(evaluateWritePolicy("node_modules/x/index.js")?.reason, "saugomas kelias");
  assert.equal(evaluateWritePolicy("dist/cli.js")?.reason, "generuotas hook runtime");
});

test("evaluateWritePolicy: .env.example šablonas praleidžiamas, kiti .env* — ne", () => {
  // Šablonas be slaptukų yra industrijos standartas (`cp .env.example .env`); be išimties
  // env kintamųjų nebūdavo kur dokumentuoti.
  assert.equal(evaluateWritePolicy(".env.example"), undefined);
  assert.equal(evaluateWritePolicy("config/.env.example"), undefined);
  assert.equal(evaluateWritePolicy(".ENV.EXAMPLE"), undefined);
  assert.deepEqual(ALLOWED_ENV_TEMPLATE_BASENAMES, [".env.example"]);

  // Išimtis yra TIKSLUS basename atitikmuo: joks kitas `.env*` variantas per ją nepralenda.
  assert.equal(evaluateWritePolicy(".env")?.reason, "saugomas failas");
  assert.equal(evaluateWritePolicy(".env.local")?.reason, "saugomas failas");
  assert.equal(evaluateWritePolicy(".env.example.local")?.reason, "saugomas failas");
  assert.equal(evaluateWritePolicy("config/.env.development")?.reason, "saugomas failas");
  // `.env.example.pem` nėra išimties vardas: jį sustabdo env taisyklė dar prieš plėtinių sąrašą,
  // tad raktų failas jokiu registru pro šabloną neįlenda.
  assert.equal(evaluateWritePolicy(".env.example.pem")?.reason, "saugomas failas");
  // Kelių patikros eina PO env patikros ir išimtis jų neišjungia.
  assert.equal(evaluateWritePolicy("node_modules/pkg/.env.example")?.reason, "saugomas kelias");
  assert.equal(evaluateWritePolicy(".git/.env.example")?.reason, "saugomas kelias");
  assert.equal(evaluateWritePolicy("../outside/.env.example")?.reason, "kelias uz projekto ribu");
});

test("evaluateWritePolicy: traversal sutraukiamas PRIEŠ prefiksų atitikimą", () => {
  // Be sutraukimo šis kelias neturi `vq/state/` substring'o ir pralįstų pro visus vartus.
  assert.equal(evaluateWritePolicy("vq/tasks/../state/task-ledger.json")?.reason, "orkestratoriaus failas");
  assert.equal(evaluateWritePolicy("../outside/x.ts")?.reason, "kelias uz projekto ribu");
});

test("evaluateWritePolicy: audit carve-out siauras, o traversal jo neapeina", () => {
  assert.equal(evaluateWritePolicy("vq/state/audit/report.json"), undefined);
  assert.equal(evaluateWritePolicy("vq/state/audit/../retry-counts.json")?.reason, "orkestratoriaus failas");
  assert.equal(evaluateWritePolicy("vq/state/retry-counts.json")?.reason, "orkestratoriaus failas");
});

test("evaluateWritePolicy: templates carve-out prisegtas prie šaknies", () => {
  // Supakuotas šablonas — paprastas source assetas.
  assert.equal(evaluateWritePolicy("templates/.claude/settings.json"), undefined);
  // Bet `templates/` gilumoje NEIŠJUNGIA saugomų kelių (2026-08-06 auditas).
  assert.equal(evaluateWritePolicy(".claude/hooks/templates/x.js")?.reason, "orkestratoriaus failas");
  assert.equal(evaluateWritePolicy("vq/state/templates/x.json")?.reason, "orkestratoriaus failas");
});

test("evaluateWritePolicy: saugomi žurnalai ir sugadinti Windows keliai", () => {
  assert.equal(evaluateWritePolicy("vq/logs/hooks.log")?.reason, "zurnalo failas");
  assert.equal(evaluateWritePolicy("vq/state/readme-read-events.json")?.reason, "orkestratoriaus failas");

  assert.equal(evaluateWritePolicy("D:Reactfoo.md")?.reason, "sugadintas kelias");
  const flattened = evaluateWritePolicy("ReactVERQESTRAlogscommit-msg.md", { projectRoot: "D:/React/VERQESTRA" });
  assert.equal(flattened?.reason, "sugadintas kelias");
});

test("isMaintenancePath: src ir manifestai leidžiami, dist — ne", () => {
  assert.equal(isMaintenancePath("src/domain/x.ts"), true);
  assert.equal(isMaintenancePath("tsconfig.json"), true);
  assert.equal(isMaintenancePath("package.json"), true);
  assert.equal(isMaintenancePath("dist/cli.js"), false);
  assert.equal(isMaintenancePath("docs/x.md"), false);
});

// ---------------------------------------------------------------------------
// readme-guard
// ---------------------------------------------------------------------------

test("resolveReadmeGuardRequirements: architektūros dokumentas reikalaujamas TIK jei egzistuoja", () => {
  const withoutDoc = resolveReadmeGuardRequirements({ sourceRoots: ["src"] });
  assert.deepEqual(withoutDoc.requiredReads, ["README.md"]);
  assert.deepEqual(withoutDoc.guardedPaths, ["/src/"]);

  const withDoc = resolveReadmeGuardRequirements({ architectureDocExists: true });
  assert.deepEqual(withDoc.requiredReads, ["README.md", DEFAULT_ARCHITECTURE_DOC]);
  assert.deepEqual(withDoc.guardedPaths, DEFAULT_README_GUARD_PATHS);

  // Glob segmentai nukerpami; profilis be panaudojamų roots grįžta į numatytuosius.
  assert.deepEqual(resolveReadmeGuardRequirements({ sourceRoots: ["apps/**", "./packages/*"] }).guardedPaths, [
    "/apps/",
    "/packages/",
  ]);
  assert.deepEqual(resolveReadmeGuardRequirements({ sourceRoots: ["*"] }).guardedPaths, DEFAULT_README_GUARD_PATHS);
});

test("evaluateReadmeGuardPolicy: saugomas kelias be įrodymo blokuojamas, su įrodymu — praeina", () => {
  const requirements = resolveReadmeGuardRequirements({ sourceRoots: ["src"], architectureDocExists: true });

  const blocked = evaluateReadmeGuardPolicy("src/app.ts", [], requirements);
  assert.equal(blocked?.reason, "readme-guard skaitymo irodymas nera");
  assert.match(blocked?.stderr ?? "", /README\.md, doc\/architecture\/README\.md/);
  // Žinutė aiškiai sako, kad rankinis įrodymų failo rašymas leidimo neduoda.
  assert.match(blocked?.stderr ?? "", /nesuteikia leidimo/);

  const partial = evaluateReadmeGuardPolicy("src/app.ts", ["README.md"], requirements);
  assert.match(partial?.stderr ?? "", /doc\/architecture\/README\.md/);

  assert.equal(
    evaluateReadmeGuardPolicy("src/app.ts", ["./README.md", "doc/architecture/README.md"], requirements),
    undefined,
  );
  // Nesaugomas kelias guard'o nereikalauja iš viso.
  assert.equal(evaluateReadmeGuardPolicy("docs/notes.md", [], requirements), undefined);
});

test("evaluateReadmeGuardPolicy: vartai galioja ir absoliučiam, ir repo-santykiniam keliui", () => {
  const requirements = resolveReadmeGuardRequirements({ sourceRoots: ["src"] });

  // Ta pati byla trimis formomis: guard'as negali priklausyti nuo to, kokios formos kelią
  // atsiuntė kvietėjas (repo-santykinė forma etalone tyliai praeidavo pro vartus).
  for (const candidate of ["src/app.ts", "./src/app.ts", "/repo/src/app.ts", "D:/repo/src/app.ts"]) {
    assert.equal(
      evaluateReadmeGuardPolicy(candidate, [], requirements)?.reason,
      "readme-guard skaitymo irodymas nera",
      `neuždarytas kelias: ${candidate}`,
    );
  }

  // Numatytieji fragmentai taip pat: `apps/web/x.tsx` be įrodymo yra blokuojamas.
  assert.equal(
    evaluateReadmeGuardPolicy("apps/web/x.tsx", [], resolveReadmeGuardRequirements())?.reason,
    "readme-guard skaitymo irodymas nera",
  );
});

// ---------------------------------------------------------------------------
// foreign-lease scope
// ---------------------------------------------------------------------------

const ROOT = "/repo";

test("classifyForeignLeaseGuardScope: produkto medis saugomas, už šaknies — carve-out", () => {
  assert.deepEqual(classifyForeignLeaseGuardScope({ filePath: "src/a.ts", projectRoot: ROOT, targetExists: true }), {
    bypass: false,
    reason: "product-tree",
  });

  assert.deepEqual(
    classifyForeignLeaseGuardScope({ filePath: "/tmp/scratch.md", projectRoot: ROOT, targetExists: false }),
    { bypass: true, reason: "outside-project-root" },
  );
});

test("classifyForeignLeaseGuardScope: queue carve-out TIK naujiems failams", () => {
  assert.deepEqual(
    classifyForeignLeaseGuardScope({ filePath: "AG/tasks/queue/0042.md", projectRoot: ROOT, targetExists: false }),
    { bypass: true, reason: "new-queue-file" },
  );
  assert.deepEqual(
    classifyForeignLeaseGuardScope({ filePath: "AG/tasks/queue/0042.md", projectRoot: ROOT, targetExists: true }),
    { bypass: false, reason: "existing-queue-file" },
  );
});

test("classifyForeignLeaseGuardScope: svetimas worktree praleidžiamas, gyvas — ne", () => {
  const foreign = classifyForeignLeaseGuardScope({
    filePath: ".claude/worktrees/w2/src/a.ts",
    projectRoot: ROOT,
    targetExists: true,
  });
  assert.deepEqual(foreign, { bypass: true, reason: "foreign-worktree" });

  const live = classifyForeignLeaseGuardScope({
    filePath: ".claude/worktrees/w2/src/a.ts",
    projectRoot: ROOT,
    targetExists: true,
    liveWorktreePaths: ["/repo/.claude/worktrees/w2"],
  });
  assert.deepEqual(live, { bypass: false, reason: "live-worktree" });

  // Pirminiam medžiui apstampuotas lease NEIŠJUNGIA carve-out'o (jis nėra worktree konteineryje).
  const stampedOnPrimary = classifyForeignLeaseGuardScope({
    filePath: ".claude/worktrees/w2/src/a.ts",
    projectRoot: ROOT,
    targetExists: true,
    liveWorktreePaths: ["/repo"],
  });
  assert.deepEqual(stampedOnPrimary, { bypass: true, reason: "foreign-worktree" });
});

test("classifyForeignLeaseGuardScope: fail-closed kryptys — .. ir degeneravusi šaknis", () => {
  assert.deepEqual(
    classifyForeignLeaseGuardScope({ filePath: "AG/tasks/queue/../../src/a.ts", projectRoot: ROOT, targetExists: false }),
    { bypass: false, reason: "product-tree" },
  );
  assert.deepEqual(
    classifyForeignLeaseGuardScope({ filePath: "../../etc/passwd", projectRoot: ROOT, targetExists: false }),
    { bypass: false, reason: "escapes-root" },
  );
  // Disko šaknis neturi nė vieno segmento — carve-out'o nėra, kitaip praleistų viską.
  assert.deepEqual(
    classifyForeignLeaseGuardScope({ filePath: "/tmp/x", projectRoot: "/", targetExists: false }),
    { bypass: false, reason: "product-tree" },
  );
});
