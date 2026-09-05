// Vartas vartui: šaknies `pnpm test` privalo paleisti ir `ui-app` paketą.
//
// Incidentas (2026-08-26): task 028 perkėlė `WavesPanel` duomenų kelią nuo globalaus `fetch` prie
// bendro kliento, o `WavesPanel.test.tsx` liko stub'inantis `fetch`. Septyni testai tapo raudoni ir
// išbuvo tokie per kelis ciklo dispatch'us — šaknies `pnpm test` jų nemato, tad ciklas laikė medį
// žaliu ir dirbo toliau. CI juos būtų pagavęs (`ci.yml` turi `typecheck:ui`, `test:ui`, `build:ui`),
// bet ciklas CI nepaleidžia: jam `pnpm test` YRA vartas.
//
// Iš to plaukia invariantas: lokalus vartas negali būti siauresnis už tai, kuo ciklas pasitiki.
// `ui-app` čia įtrauktas, nes jis diegiamas kartu su šaknimi (`pnpm install` darbo sritys) ir yra
// žalias. `mobile-*` ir `AG/benchmark` SĄMONINGAI neįtraukti: jų `node_modules` šioje kopijoje nėra,
// tad pridėti juos reikštų padaryti `pnpm test` raudoną kiekvienam, kas dar nepaleido tų paketų
// diegimo. Jie lieka CI atsakomybė — ta pati riba, kurią `ci.yml` komentaruose jau įvardija.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

type PackageManifest = { scripts?: Record<string, string> };

function manifestScripts(...relativeSegments: string[]): Record<string, string> {
  const manifestPath = path.join(process.cwd(), ...relativeSegments, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  return manifest.scripts ?? {};
}

function rootScripts(): Record<string, string> {
  return manifestScripts();
}

/**
 * Formos, kurios `vitest run` PAVADINIMĄ palieka, o veiksmą nuima. Sąrašas literalus, nes kiekvienas
 * narys yra atskiras būdas gauti žalią NULINĮ bėgimą, o ne to paties argumento variantas.
 */
const NEUTRALIZERS = ["--passWithNoTests", "--dir", "|| true", "|| exit 0"] as const;

/** `ui-app` `test` script'o pažeidimai. Grynas, kad tą pačią taisyklę matytų ir korpusas, ir fixture'as. */
function uiTestScriptViolations(script: string): string[] {
  const violations: string[] = [];
  if (!/^vitest run(\s|$)/.test(script.trim())) violations.push(`nepradeda \`vitest run\`: ${script}`);
  for (const neutralizer of NEUTRALIZERS) {
    if (script.includes(neutralizer)) violations.push(`neutralizuojantis argumentas \`${neutralizer}\``);
  }
  return violations;
}

/** `//` komentarai nuimami: konfigo paaiškinimas neturi atrodyti kaip `include:` deklaracija. */
function withoutLineComments(source: string): string {
  return source.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * `include` pažeidimai. Jo NEBUVIMAS teisėtas: vitest tada ima numatytąjį `**\/*.test.*` ir mato
 * viską. Korpuse (2026-09-05) `include` nėra, tad ši šaka tuščia SĄMONINGAI — ji saugo ateitį,
 * kurioje sąrašas atsiras ir tyliai išbrauks `src/tests/**`.
 */
function vitestIncludeViolations(config: string): string[] {
  const include = /\binclude\s*:\s*\[([^\]]*)\]/.exec(withoutLineComments(config));
  if (include?.[1] === undefined) return [];
  const patterns = [...include[1].matchAll(/["'`]([^"'`]+)["'`]/g)].flatMap((match) => match[1] ?? []);
  const covers = patterns.some((pattern) => pattern.includes("src/tests/") || /^(?:\*\*|src\/\*\*)/.test(pattern));
  return covers ? [] : [`\`include\` nedengia \`src/tests/**\`: ${patterns.join(", ")}`];
}

test("šaknies `pnpm test` paleidžia ui-app tipus ir testus", () => {
  const scripts = rootScripts();
  const testScript = scripts["test"];

  assert.ok(testScript, "šaknies package.json neturi `test` script'o");
  assert.match(
    testScript,
    /\btest:ui\b/,
    "`pnpm test` nebepaleidžia `test:ui` — ui-app regresijos vėl taps nematomos ciklui",
  );
  assert.match(
    testScript,
    /\btypecheck:ui\b/,
    "`pnpm test` nebepaleidžia `typecheck:ui` — vitest tipų netikrina, tad ui tipų klaida praeitų vartus",
  );
});

test("ui-app vartų script'ai egzistuoja ir rodo į ui-app katalogą", () => {
  const scripts = rootScripts();

  for (const name of ["test:ui", "typecheck:ui"]) {
    const script = scripts[name];
    assert.ok(script, `šaknies package.json neturi \`${name}\` script'o`);
    assert.match(
      script,
      /--dir ui-app\b/,
      `\`${name}\` nebenukreipia į ui-app — vartas liktų pavadinime, bet ne veiksme`,
    );
  }
});

// Iki 2026-09-05 vartas baigėsi ties šaknies `package.json` eilutėmis. Tai reiškė, kad jis tikrino
// KVIETIMĄ, o ne bėgimą: `ui-app/package.json` su `"test": "vitest run --passWithNoTests --dir
// nonexistent"` būtų palikęs abu viršutinius testus žalius, o 2026-08-26 incidentas — septyni
// raudoni testai, kurių šaknis nemato — grįžtų nepakitęs. Todėl vartas skaito ir grandinės galą.

test("ui-app `test` script'as tikrai paleidžia vitest, o ne jo pavadinimą", () => {
  const script = manifestScripts("ui-app")["test"];
  assert.ok(script, "ui-app/package.json neturi `test` script'o — `pnpm test:ui` nieko nepaleistų");
  assert.deepEqual(
    uiTestScriptViolations(script),
    [],
    "ui-app `test` script'as neutralizuotas — šaknies `test:ui` liktų žalias be nė vieno bėgusio testo",
  );
});

test("ui-app vitest konfigas neišbraukia `src/tests/**` iš `include`", () => {
  const config = readFileSync(path.join(process.cwd(), "ui-app", "vitest.config.ts"), "utf8");
  assert.deepEqual(
    vitestIncludeViolations(config),
    [],
    "vitest `include` susiaurintas — dalis ui-app testų nebebėga, o vartas to nemato",
  );
});

test("apėjimai, kuriuos šis vartas privalo pagauti, yra raudoni", () => {
  // Fixture'ai, ne korpusas: taisyklė tikrinama prieš tekstą, kurio repo neturi ir neturės.
  assert.notDeepEqual(uiTestScriptViolations("vitest run --passWithNoTests --dir nonexistent"), []);
  assert.notDeepEqual(uiTestScriptViolations("vitest run || true"), []);
  assert.notDeepEqual(uiTestScriptViolations("echo skipped"), []);
  assert.deepEqual(uiTestScriptViolations("vitest run"), []);
  assert.deepEqual(uiTestScriptViolations("vitest run --reporter dot"), []);

  assert.notDeepEqual(vitestIncludeViolations('export default { test: { include: ["src/view/**/*.test.tsx"] } }'), []);
  assert.deepEqual(vitestIncludeViolations('export default { test: { include: ["src/tests/**/*.test.ts"] } }'), []);
  assert.deepEqual(vitestIncludeViolations("export default { test: { exclude: [\"dist\"] } }"), []);
});
