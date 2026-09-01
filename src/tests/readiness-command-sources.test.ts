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

test("dokumentuotų ir implementuotų komandų sankirta netuščia", () => {
  const documented = parseReadmeMainCommands(readSource("README.md"));
  const implemented = parseRegisteredCommands(readinessRequirements.commandSources.map(readSource));

  assert.ok(documented.length > 0, "README `## Main Commands` sekcija neduoda nė vienos komandos");

  const shared = documented.filter((command) => implemented.includes(command));
  assert.ok(
    shared.length > 0,
    `README dokumentuoja ${documented.length} komandų, registras registruoja ${implemented.length}, bet sankirta tuščia — auditas lygina su ne ta aibe`,
  );
});
