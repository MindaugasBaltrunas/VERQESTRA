// UI autostart'o PRIJUNGIMO vartai (2026-08-24 UI audito trečias ratas).
//
// Kodėl vartas, o ne susitarimas. `interfaces/http/ui-lifecycle.ts` buvo pilnai perkeltas ir
// ištestuotas — 170 eilučių su starto malonės langu, tarpprocesine serializacija ir savo
// klaidų kelia — bet turėjo NULĮ produkcinių kvietėjų. Jo paties komentaras skelbė „production
// kvietėjas rezultato neima", nors kvietėjo nebuvo iš viso. Etalone jį kviečia
// `interfaces/cli/claude-loop/index.ts` prieš pat `claudeLoop()`, tad `verqestra loop` ten pats
// pakelia dashboard'ą; pas mus operatorius jo negaudavo, kol nepaleisdavo `verqestra ui` ranka.
//
// Tai buvo SEPTINTAS šio repo „mechanizmas be wiring'o" atvejis, ir visi septyni praėjo pro žalius
// testus. Vienetiniai testai tokio praradimo pagauti negali: jie tikrina mechanizmą, o ne tai, ar
// kas nors jį kviečia. Todėl vartas skaito ŠALTINĮ — lygiai kaip `scheduling-safe-telemetry`.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { UI_AUTOSTART_ENV } from "../interfaces/http/ui-lifecycle.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/** Kodas be komentarų: komentare paminėtas vardas nėra kvietimas. */
async function codeOf(relativePath: string): Promise<string> {
  const source = await readFile(path.join(SRC, relativePath), "utf8");
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

test("gate: `loop` komanda PAKELIA dashboard'ą — `ensureUiRunning` turi produkcinį kvietėją", async () => {
  const code = await codeOf("composition/cli/commands-ops.ts");

  assert.equal(
    code.includes("ensureUiRunning("),
    true,
    "ui-lifecycle be kvietėjo yra mechanizmas, kurio niekas nepaleidžia — būtent tai auditas ir rado",
  );

  // Kvietimas privalo būti PRIEŠ ciklą: po `runLoopCommand` jis įvyktų tik eilei ištuštėjus, t. y.
  // tada, kai dashboard'o nebereikia.
  const autostartAt = code.indexOf("ensureUiRunning(");
  const loopAt = code.indexOf("runLoopCommand(");
  assert.ok(autostartAt >= 0 && loopAt >= 0);
  assert.ok(autostartAt < loopAt, "dashboard'as keliamas PRIEŠ ciklą, o ne po jo");
});

test("gate: kiekvienas mūsų spawn'intas vaikas gauna `AG_UI_AUTOSTART=0`", async () => {
  const code = await codeOf("composition/ui/lifecycle-adapters.ts");

  // Be vėliavos grandinė būtų begalinė: UI paleidžia loop'ą, loop'as (nuo šio rato) pakelia UI,
  // tas vėl paleidžia loop'ą. Vėliava paveldima, tad ji uždaro VISĄ grandinę, ne vieną pakopą.
  // Skaidoma pagal KVIETIMO formą, ne pagal vardą: `function spawnDetachedCli(` yra deklaracija,
  // ir ji į šį vartą neįeina.
  const spawns = code.split("spawnDetachedCli(input.projectRoot,").slice(1);
  assert.equal(spawns.length, 2, "spawn'ų yra du: loop ir UI — abu privalo būti šio varto akiratyje");
  for (const spawn of spawns) {
    assert.equal(
      spawn.slice(0, 200).includes("UI_AUTOSTART_ENV"),
      true,
      "vaikas be vėliavos keltų dar vieną UI, o jo vaikas — dar vieną",
    );
  }
});

test("`AG_UI_AUTOSTART` yra kontrakto vardas, o ne literalas dviejose vietose", async () => {
  // Vardas ateina iš `ui-lifecycle`, kuris jį ir tikrina. Antra literalo kopija kompozicijoje
  // reikštų, kad pervadinus vieną pusę išjungimo jungiklis tyliai nustotų veikti.
  assert.equal(UI_AUTOSTART_ENV, "AG_UI_AUTOSTART");

  const code = await codeOf("composition/ui/lifecycle-adapters.ts");
  assert.equal(code.includes(`"${UI_AUTOSTART_ENV}"`), false, "vėliavos vardas imamas iš modulio, ne rašomas ranka");
});
