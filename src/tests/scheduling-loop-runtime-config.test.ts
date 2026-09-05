// Task 170 (pilnas auditas 2026-09-05, L9): trys laiko langai, kurie anksčiau gyveno trimis
// nesuderintais literalais, dabar turi vieną šaltinį.
//
// Šis failas pina DU dalykus, ir jie skiriasi griežtumu:
//   1. TVARKĄ tarp konstantų (pirmi du testai) — ji negali apsiversti niekada;
//   2. abi ATSARGAS virš bendros ribos (trečias testas) — tai kalibruotos reikšmės, tad jų
//      keitimas SĄMONINGAI nudažo šį failą raudonai. Atsargą kelti galima, bet ne tyliai:
//      pakeitimas privalo praeiti pro čia.
//
// Kodėl vartas: 159 pakėlė turn lubas ir nė vienos iš trijų konstantų nepajudino, nes niekas jų
// nesiejo. Nuo šiol bet kuris kėlimas, kuris apverstų eiliškumą, krenta čia.

import assert from "node:assert/strict";
import { test } from "node:test";
import { WAVE_SLOT_LEASE_TTL_MS } from "../application/scheduling/loop-runtime-config.js";
import { LIVE_DISPATCH_MAX_AGE_MS } from "../application/task-execution/session-baseline.js";
import { MAX_DERIVED_DISPATCH_TIMEOUT_MS } from "../application/token-governance/token-budget-config.js";
import { MAX_DISPATCH_WALL_CLOCK_MS, resolveDispatchTimeoutMs } from "../application/token-governance/turn-budget.js";

test("loop-runtime-config: numatytas dispatch langas <= gyvumo langas <= lease TTL", () => {
  const defaultLargeDispatchMs = resolveDispatchTimeoutMs({ tier: "large" });

  // Gyvas large dispatch'as negali būti paskelbtas negyvu vien todėl, kad dirbo iki savo lango
  // pabaigos: būtent taip 90 min riba nurašydavo 100 min dispatch'ą.
  assert.ok(
    defaultLargeDispatchMs <= LIVE_DISPATCH_MAX_AGE_MS,
    `numatytas large dispatch langas ${defaultLargeDispatchMs} ms > gyvumo langas ${LIVE_DISPATCH_MAX_AGE_MS} ms`,
  );
  // Slot'o lease privalo pergyventi patį gyvumo langą — kitaip `loop-guard` ar antras loop
  // startas atlaisvina slot'ą sesijai, kurią ta pati kodo bazė tebelaiko gyva.
  assert.ok(
    LIVE_DISPATCH_MAX_AGE_MS <= WAVE_SLOT_LEASE_TTL_MS,
    `gyvumo langas ${LIVE_DISPATCH_MAX_AGE_MS} ms > lease TTL ${WAVE_SLOT_LEASE_TTL_MS} ms`,
  );
});

test("loop-runtime-config: konfigo lubos GRIEŽTAI žemiau lease TTL", () => {
  // Ne `<=`, o `<`: operatoriaus konfigas gali išvesti langą iki pat šių lubų, ir tokiam
  // dispatch'ui lease turi likti gyvas dar PO jo pabaigos (integracija, merge, valymas).
  assert.ok(
    MAX_DERIVED_DISPATCH_TIMEOUT_MS < WAVE_SLOT_LEASE_TTL_MS,
    `kompozicinės lubos ${MAX_DERIVED_DISPATCH_TIMEOUT_MS} ms >= lease TTL ${WAVE_SLOT_LEASE_TTL_MS} ms`,
  );
  // Lubos ir gyvumo langas kyla iš to paties fakto: atsarga eina virš ribos, ne po ja.
  assert.ok(
    MAX_DERIVED_DISPATCH_TIMEOUT_MS <= LIVE_DISPATCH_MAX_AGE_MS,
    `konfigas leidžia ${MAX_DERIVED_DISPATCH_TIMEOUT_MS} ms dispatch'ą, kurį gyvumo langas ` +
      `${LIVE_DISPATCH_MAX_AGE_MS} ms nurašytų dar jam dirbant`,
  );
});

test("loop-runtime-config: abi atsargos matuojamos nuo tos pačios ribos", () => {
  // Išvedimas, ne sutapimas: literalu grąžinta reikšmė čia išliktų žalia tik atsitiktinai, tad
  // tikrinamas pats ryšys su `MAX_DISPATCH_WALL_CLOCK_MS`.
  assert.equal(LIVE_DISPATCH_MAX_AGE_MS - MAX_DISPATCH_WALL_CLOCK_MS, 10 * 60 * 1000);
  assert.equal(WAVE_SLOT_LEASE_TTL_MS - MAX_DISPATCH_WALL_CLOCK_MS, 60 * 60 * 1000);
});
