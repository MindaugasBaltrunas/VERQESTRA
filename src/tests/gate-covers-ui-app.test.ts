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

function rootScripts(): Record<string, string> {
  const manifestPath = path.join(process.cwd(), "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  return manifest.scripts ?? {};
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
