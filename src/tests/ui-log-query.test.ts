// 2026-08-24 — `/api/logs`: NAUJAS maršrutas, ne perkėlimas.
//
// Kontekstas, be kurio šie testai atrodo savavališki: etalono orkestratoriaus UI serveris
// (`AG/orchestrator/src/interfaces/http/ui-server.ts`) aptarnavo septynis `/api/**` maršrutus, ir
// `/api/logs` tarp jų NEBUVO. Tas kelias visame AG_loop egzistavo dviejose vietose, abiejose
// `AG/mobile-gateway` viduje: adapteryje, kuris jo prašo, ir jo teste, kuris HTTP sluoksnį
// pakeičia fake'u ir tiesiog DEKLARUOJA atsakymą. Tad mobile pusė kalbėjo su maršrutu, kurio nė
// vienas serveris neaptarnavo.
//
// Šie testai pin'ina sprendimus, kurių etalonas nepriėmė: vardų allowlist'as, nežinomas vardas =
// 400, nesantis failas = tuščias vokas, ir dvigubos ribos (eilučių + simbolių) nuo GALO.

import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedLogLines,
  buildUiLogsResponse,
  isUiLogName,
  normalizeUiLogLines,
  uiLogFileName,
  UI_LOG_LINE_CHAR_LIMIT,
  UI_LOG_LINE_DEFAULT,
  UI_LOG_LINE_LIMIT,
  UI_LOG_NAMES,
} from "../application/analytics/ui-log-query.js";

test("žurnalo vardas yra ALLOWLIST, ne kelias", () => {
  // Vardą į failą verčia serveris. Be šito `log=../../.env` būtų kelio traversal primityvas:
  // maršrutas turi token'ą, bet ne failų sistemos ribą.
  assert.deepEqual([...UI_LOG_NAMES].sort(), ["checks", "claude", "orchestrator"]);
  assert.equal(isUiLogName("claude"), true);
  assert.equal(uiLogFileName("claude"), "claude-last.log");
  for (const rejected of ["../../.env", "hooks", "claude-last.log", "", "CLAUDE", null]) {
    assert.equal(isUiLogName(rejected), false, String(rejected));
  }
});

test("nežinomas vardas neduoda numatytojo žurnalo", () => {
  // Atiduoti KITĄ žurnalą tuo pačiu voku reikštų atsakymą, kurio klientas negali atskirti nuo
  // teisingo. `isUiLogName` yra vienintelis vartas, ir jis atsako „ne", o ne „claude".
  assert.equal(isUiLogName("orchestratorius"), false);
});

test("`?lines=` normalizuojamas, o ne atmetamas", () => {
  assert.equal(normalizeUiLogLines(null), UI_LOG_LINE_DEFAULT);
  assert.equal(normalizeUiLogLines(""), UI_LOG_LINE_DEFAULT);
  assert.equal(normalizeUiLogLines("abc"), UI_LOG_LINE_DEFAULT);
  assert.equal(normalizeUiLogLines("0"), UI_LOG_LINE_DEFAULT);
  assert.equal(normalizeUiLogLines("-5"), UI_LOG_LINE_DEFAULT);
  assert.equal(normalizeUiLogLines("7"), 7);
  // Už ribos — nukerpama iki ribos, ne klaida: `lines` yra patogumas, ne kontraktas.
  assert.equal(normalizeUiLogLines("100000"), UI_LOG_LINE_LIMIT);
});

test("ribos taikomos nuo GALO — žurnale šviežiausia yra apačioje", () => {
  const content = "a\nb\nc\nd\ne\n";
  const bounded = boundedLogLines(content, 2, UI_LOG_LINE_CHAR_LIMIT);
  assert.deepEqual(bounded.lines, ["d", "e"]);
  assert.equal(bounded.truncated, true);

  // Uodeginis `\n` yra failo baigiamasis simbolis, ne tuščia eilutė: kitaip kiekvienas žurnalas
  // atrodytų turįs vieną tuščią eilutę daugiau nei turi.
  const whole = boundedLogLines(content, 10, UI_LOG_LINE_CHAR_LIMIT);
  assert.deepEqual(whole.lines, ["a", "b", "c", "d", "e"]);
  assert.equal(whole.truncated, false);
});

test("tuščios eilutės VIDURYJE išlieka", () => {
  // Todėl atsakymas yra sąrašas, o ne sujungtas tekstas: sujungus ir vėl skaidžius, tuščia
  // eilutė ir eilučių riba nebeatskiriamos.
  const bounded = boundedLogLines("a\n\nb\n", 10, UI_LOG_LINE_CHAR_LIMIT);
  assert.deepEqual(bounded.lines, ["a", "", "b"]);
  assert.equal(bounded.truncated, false);
});

test("per ilga eilutė kerpama iš PRIEKIO ir žymi truncated", () => {
  // Viena minifikuota eilutė gali svarti daugiau nei du tūkstančiai įprastų, tad eilučių riba
  // nieko nesako apie svorį. Kerpama iš priekio, nes eilutės pabaiga yra šviežiausia jos dalis.
  const long = `${"x".repeat(20)}TAIL`;
  const bounded = boundedLogLines(long, 10, 8);
  assert.deepEqual(bounded.lines, ["xxxxTAIL"]);
  assert.equal(bounded.truncated, true);
});

test("nesantis žurnalas yra TUŠČIAS vokas, ne klaida", () => {
  // Žurnalas, į kurį dar niekas nerašė, yra normali būsena šviežiame `vq/`. 404 čia reikštų
  // „nėra tokio žurnalo" — visiškai kitą faktą, kurį klientas turėtų traktuoti kitaip.
  const response = buildUiLogsResponse("checks", undefined, UI_LOG_LINE_DEFAULT);
  assert.deepEqual(response, { log: "checks", lines: [], truncated: false });
});

test("vokas nešą TĄ patį žurnalo vardą, kurio prašė klientas", () => {
  const response = buildUiLogsResponse("orchestrator", "one\ntwo\n", UI_LOG_LINE_DEFAULT);
  assert.equal(response.log, "orchestrator");
  assert.deepEqual(response.lines, ["one", "two"]);
  assert.equal(response.truncated, false);
});

test("ribos sutampa su mobile kontrakto ribomis", () => {
  // `AG/mobile-gateway` `ag-loop-ui-read-port` deklaruoja tuos pačius skaičius, ir abi pusės
  // privalo klampinti VIENODAI: kitaip gateway'aus clamp'as taptų antra politika, tyliai
  // perrašančia tai, ką serveris jau nusprendė.
  assert.equal(UI_LOG_LINE_LIMIT, 200);
  assert.equal(UI_LOG_LINE_DEFAULT, 100);
  assert.equal(UI_LOG_LINE_CHAR_LIMIT, 4096);
});
