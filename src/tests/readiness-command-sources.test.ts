// Vartas `readinessRequirements.commandSources` sąrašui: keliai privalo rodyti į REALIUS failus.
//
// Ta pati klaida lūžo du kartus. 11/N komandos buvo iškeltos iš vieno `cli-registry.ts` į teminius
// pjūvius, ir sąrašas matė 4 komandas iš 53. 2026-09-01 registras persikėlė į `src/composition/cli/`
// katalogą, o sąrašas liko rodyti į plokščius `src/composition/cli-*.ts`: visi aštuoni keliai tapo
// mirę, `readTextFileIfExists` grąžino `undefined` kiekvienam, `implemented_commands` liko tuščias,
// ir `readiness-audit` skelbė `implementation:<komanda>` KIEKVIENAI dokumentuotai komandai.
//
// Abu kartus lūžis buvo TYLUS, ir būtent tai yra problema: neegzistuojančio kelio skaitymas nėra
// klaida — `readTextFileIfExists` sąmoningai grąžina `undefined`. Auditas neturi iš ko atskirti
// „registre nėra tokios komandos" nuo „nepataikiau į registrą", tad melagingą verdiktą pateikia
// tvirtai. Todėl sąrašas tikrinamas prieš REALŲ repo, o ne prieš stub'ą: stub'as atkartotų tą pačią
// aklą vietą. Šis testas yra fail-closed — pervadinus ar perkėlus registro failą jis krinta iš
// karto, o ne kitą kartą, kai kas nors atidžiai perskaitys audito išvestį.

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  parseReadmeMainCommands,
  parseRegisteredCommands,
} from "../application/release-readiness/readiness-audit.js";
import { readinessRequirements } from "../composition/quality/readiness-adapters.js";

const REPO_ROOT = process.cwd();

function absoluteSource(relativePath: string): string {
  return path.join(REPO_ROOT, ...relativePath.split("/"));
}

function readSource(relativePath: string): string {
  return readFileSync(absoluteSource(relativePath), "utf8");
}

/**
 * Dokumentuotos komandos, kurių registre nėra.
 *
 * Iki 2026-09-05 vartas tikrino, kad sankirta NETUŠČIA. Bet lūžis, dėl kurio jis gimė, buvo
 * „sąrašas matė 4 komandas iš 53" — ten sankirta irgi buvo netuščia. `> 0` praeina ir tada, kai
 * `commandSources` rodo į vieną teisingą failą iš aštuonių, tad vartas matuoja tai, kas nelūžo.
 * Matuoti reikia SPRAGĄ: kiekviena README dokumentuota komanda privalo rastis registre — būtent
 * tokį verdiktą `readiness-audit` ir skelbia (`implementation:<komanda>`).
 */
function missingFromRegistry(documented: readonly string[], implemented: readonly string[]): string[] {
  return documented.filter((command) => !implemented.includes(command)).sort();
}

test("kiekvienas commandSources kelias egzistuoja realiame repo", () => {
  assert.ok(readinessRequirements.commandSources.length > 0, "commandSources sąrašas tuščias — auditas nieko nematuoja");

  for (const source of readinessRequirements.commandSources) {
    let kind: "file" | "absent" = "absent";
    try {
      kind = statSync(absoluteSource(source)).isFile() ? "file" : "absent";
    } catch {
      kind = "absent";
    }
    assert.equal(
      kind,
      "file",
      `commandSources rodo į neegzistuojantį failą: ${source} — readiness-audit šį kelią skaitys kaip tuščią ir paskelbs visas komandas neįgyvendintomis`,
    );
  }
});

test("commandSources realiai duoda registruotas komandas", () => {
  const sources = readinessRequirements.commandSources.map(readSource);
  const implemented = parseRegisteredCommands(sources);

  assert.ok(
    implemented.length > 0,
    "parseRegisteredCommands iš commandSources negavo NĖ VIENOS komandos — sąrašas nerodo į registrą",
  );
});

test("KIEKVIENA dokumentuota komanda randama registre, ne tik kelios", () => {
  const documented = parseReadmeMainCommands(readSource("README.md"));
  const implemented = parseRegisteredCommands(readinessRequirements.commandSources.map(readSource));

  assert.ok(documented.length > 0, "README `## Main Commands` sekcija neduoda nė vienos komandos");

  const missing = missingFromRegistry(documented, implemented);
  assert.deepEqual(
    missing,
    [],
    `README dokumentuoja ${documented.length} komandų, o registras per commandSources duoda ` +
      `${implemented.length}: šių nerado nė viename sąrašo faile — ${missing.join(", ")}. ` +
      "Arba sąrašas nerodo į visą registrą, arba README žada komandą, kurios nėra",
  );
});

test("apėjimas, kurį šis vartas privalo pagauti, yra raudonas", () => {
  // Fixture'as, ne repo: „4 komandos iš 53" forma — sankirta netuščia, bet spraga didžiulė.
  assert.deepEqual(missingFromRegistry(["loop", "status", "smoke"], ["loop"]), ["smoke", "status"]);
  assert.deepEqual(missingFromRegistry(["loop", "status"], ["status", "loop", "ui"]), []);
});
