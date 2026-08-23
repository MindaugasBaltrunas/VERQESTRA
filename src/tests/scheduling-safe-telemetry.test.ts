// 2026-08-23 (operatoriaus radinys): telemetrijos klaida nutraukdavo DAG planavimą.
//
// `wave-scheduler` antraštė deklaruoja trečią taisyklę — „telemetrija bangos NIEKADA nenutraukia" —
// ir tam turėjo vietinius `safeLog`/`safeEvent`. Bet į sub-koordinatorius keliavo NEAPSAUGOTI
// `deps.log` ir `deps.recordEvent`, tad taisyklė galiojo tik ten, kur ją prisiminė kviečiantysis.
//
// Atkurta prieš gyvą kodą (`wave-graph.refresh`): importui lūžus IR žurnalui lūžus, vietoj
// `{kind:"unavailable"}` visas `refresh()` būdavo atmestas su `Error: log`. Blogiau — krisdavo ir
// SVEIKAS kelias, nes `TASK GRAPH SNAPSHOT` eilutė rašoma ir sėkmės atveju.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSafeTelemetry, createSafeLog } from "../application/scheduling/safe-telemetry.js";
import { createWaveGraphCoordinator } from "../application/scheduling/wave-graph.js";

// Ta pati šaknis kaip `architecture-gates`: testas bėga iš `dist`, tad šaltinis imamas nuo repo
// šaknies, o ne nuo modulio vietos.
const SRC = path.resolve(process.cwd(), "src");

const throwing = {
  log: () => Promise.reject(new Error("log")),
  recordEvent: () => Promise.reject(new Error("event")),
};

test("saugus adapteris nutyli abi rašymo klases", async () => {
  const { safeLog, safeEvent } = createSafeTelemetry(throwing);
  await safeLog("bet kas");
  await safeEvent({ run_id: "r1", wave_id: "w1", graph_hash: "h", event: "x" });
  await createSafeLog(throwing.log)("bet kas");
  // Nė vienas `await` neturi mesti — testo praėjimas ir yra teiginys.
});

test("grafo koordinatorius su SAUGIAIS portais grąžina verdiktą, o ne klaidą", async () => {
  const { safeLog, safeEvent } = createSafeTelemetry(throwing);
  const coordinator = createWaveGraphCoordinator({
    runId: "r1",
    importGraph: () => Promise.reject(new Error("markdown sugadintas")),
    writeGraphSnapshot: () => Promise.resolve(),
    log: safeLog,
    recordEvent: safeEvent,
    approvals: () => [],
    statuses: () => ({ completed: new Set(), blocked: new Set(), running: new Set() }),
  });

  const refreshed = await coordinator.refresh("w1");
  assert.equal(refreshed.kind, "unavailable", "fail-closed kelias privalo IŠGYVENTI savo paties telemetriją");
  assert.match(refreshed.kind === "unavailable" ? refreshed.reason : "", /markdown sugadintas/, "priežastis — tikroji, ne žurnalo");
});

// Vartas, o ne susitarimas. Iki taisymo `wave-scheduler` turėjo vietinius wrapper'ius, bet
// NEAPSAUGOTI portai vis tiek buvo pasiekiami tame pačiame faile — ir keturiuose surišimuose bei
// vienuolikoje tiesioginių kvietimų jais ir buvo pasinaudota. Dabar wrapper'is gyvena atskirai, o
// šis testas laiko taisyklę: planuoklyje neapsaugotų portų nebeminima NIEKUR.
test("gate: wave-scheduler neliečia neapsaugotų telemetrijos portų", async () => {
  const source = await readFile(path.join(SRC, "application/scheduling/wave-scheduler.ts"), "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
    .join("\n");

  for (const forbidden of ["deps.log", "deps.recordEvent"]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `${forbidden} planuoklyje neleidžiamas: diagnostika eina per createSafeTelemetry, o kitaip taisyklė galioja tik iš atminties`,
    );
  }
});
