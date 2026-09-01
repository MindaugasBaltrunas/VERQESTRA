// Vartas prieš `commandSources` kelių dreifą: readiness auditas privalo matuoti REALŲ registrą.
//
// Ta pati klasė lūžo du kartus. 11/N komandos iškeltos į teminius `commands-*` failus, o sąrašas
// liko su vienu registro failu — auditas matė 4 komandas iš 53. 2026-09-01 registras persikėlė į
// `src/composition/cli/`, o sąrašas liko rodyti į `src/composition/cli-*.ts`: `readTextFileIfExists`
// nerado NĖ VIENO failo, `implemented_commands` liko tuščias, ir auditas skelbė
// `implementation:<komanda>` kiekvienai README komandai — t. y. kaltino dokumentaciją savo paties
// aklumu.
//
// Bendra abiejų incidentų priežastis: sąrašas yra deklaracija apie failų sistemą, o deklaracija be
// varto tyliai pasensta. Todėl šis testas yra INTEGRACINIS — jis tikrina prieš tikrą repo medį, ne
// prieš fixture'ą. Fixture būtų žalias abiem incidentais.
//
// Fail-closed dvejopai: (1) dingęs ar pervadintas kelias krenta iškart; (2) net jei visi keliai
// egzistuoja, bet registracijos nebeatpažįstamos, krenta netuščios aibės ir netuščios sankirtos
// tvirtinimai — kelio buvimas nėra tas pats, kas matavimas.

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  parseReadmeMainCommands,
  parseRegisteredCommands,
} from "../application/release-readiness/readiness-audit.js";
import { readinessRequirements } from "../composition/quality/readiness-adapters.js";

const projectRoot = process.cwd();

function absolute(relativePath: string): string {
  return path.join(projectRoot, ...relativePath.split("/"));
}

function readSources(): string[] {
  return readinessRequirements.commandSources.map((source) => readFileSync(absolute(source), "utf8"));
}

test("kiekvienas commandSources kelias egzistuoja realiame repo", () => {
  assert.ok(
    readinessRequirements.commandSources.length > 0,
    "commandSources tuščias — auditas neturėtų iš ko skaityti registracijų",
  );

  for (const source of readinessRequirements.commandSources) {
    let kind: "file" | "absent" = "absent";
    try {
      kind = statSync(absolute(source)).isFile() ? "file" : "absent";
    } catch {
      kind = "absent";
    }
    assert.equal(
      kind,
      "file",
      `commandSources rodo į neegzistuojantį failą: ${source} — readiness auditas šio pjūvio nebematuos`,
    );
  }
});

test("commandSources rodo į cli/ katalogą, ne į mirusią cli-* formą", () => {
  const stale = readinessRequirements.commandSources.filter((source) => /^src\/composition\/cli-/.test(source));
  assert.deepEqual(stale, [], "commandSources grįžo prie `src/composition/cli-*.ts` — tokių failų repo nėra");
});

test("registro pjūviai duoda netuščią implementuotų komandų aibę", () => {
  const implemented = parseRegisteredCommands(readSources());

  assert.ok(
    implemented.length > 0,
    "parseRegisteredCommands negrąžino nė vienos komandos — auditas lygintų README su tuščia aibe",
  );
  // `loop` ir `readiness-audit` yra dispatch'o šerdis: jei net jų nematyti, matuojamas ne registras.
  for (const command of ["loop", "readiness-audit"]) {
    assert.ok(implemented.includes(command), `registre nerasta \`${command}\` — commandSources dengia ne tą pjūvį`);
  }
});

test("dokumentuotų ir implementuotų komandų sankirta netuščia", () => {
  const documented = parseReadmeMainCommands(readFileSync(absolute("README.md"), "utf8"));
  const implemented = parseRegisteredCommands(readSources());
  const intersection = documented.filter((command) => implemented.includes(command));

  assert.ok(documented.length > 0, "README `## Main Commands` sekcija neduoda komandų — auditas neturi ką lyginti");
  assert.ok(
    intersection.length > 0,
    "README ir registras nesikerta nė viena komanda — auditas skelbtų `implementation:` visoms dokumentuotoms",
  );
});
