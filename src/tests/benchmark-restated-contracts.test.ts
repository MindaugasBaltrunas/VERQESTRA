// Konstantos, kurios PERSAKYTOS abiejose pusėse, ir vienintelė vieta, kur jos surišamos.
//
// BENCH-1 draudžia orkestratoriui siekti į benchmark paketo vidų, tad kelias, vardo forma ir
// sidecar'o priesaga yra perrašytos čia ranka. Iki šiol jas laikė tik tai, kad jas rašė tas pats
// žmogus tą pačią dieną. Trys atskiri šios sesijos defektai buvo būtent tokie — vartai, likę prie
// kelio, kurio paketas nebeturi; komentaras, aprašantis testą, kurio nėra; laukas, kurio reikšmė
// negalėjo pasikeisti. Persakymas be saugiklio yra tos pačios klasės ketvirtas.
//
// Šaltinis skaitomas kaip tekstas, o ne importuojamas: importas ir būtų tas pats BENCH-1
// pažeidimas, kurio dėl persakymas apskritai atsirado. Todėl testas atsiremia į DEKLARACIJĄ —
// pervadinus ar perkėlus konstantą, jis krenta su „nerasta", o ne tyliai praeina.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  BENCHMARK_RUN_LEDGER_DIRECTORY,
  RUN_IDENTITY_SUFFIX,
} from "../application/benchmark/report-provenance.js";
import { BENCHMARK_PACKAGE_RELATIVE_PATH } from "../application/benchmark/suite-report-view.js";
import {
  RUN_IDENTITY_RELATIVE_DIRECTORY,
  RUN_IDENTITY_SUFFIX as COMPRESSION_RUN_IDENTITY_SUFFIX,
} from "../application/release-readiness/compression-quality-evidence.js";

const LEDGER_STORE = path.join(
  process.cwd(),
  "AG",
  "benchmark",
  "src",
  "infrastructure",
  "run-ledger-store.ts",
);

const PROVENANCE = path.join(
  process.cwd(),
  "src",
  "application",
  "benchmark",
  "report-provenance.ts",
);

/** Vienos deklaracijos reikšmė iš šaltinio, arba klaida, įvardijanti, ko nerasta. */
async function declared(file: string, pattern: RegExp, what: string): Promise<string> {
  const source = await readFile(file, "utf8");
  const match = pattern.exec(source);
  assert.ok(
    match?.[1] !== undefined,
    `${what} nerasta ${path.relative(process.cwd(), file)} — konstanta pervadinta arba perkelta, ` +
      "ir persakymas nebeturi su kuo būti sulygintas",
  );
  return match[1];
}

test("persakytas ledger'io katalogas sutampa su tuo, kurį paketas rašo", async () => {
  const packageValue = await declared(
    LEDGER_STORE,
    /export const RUN_LEDGER_DIRECTORY = "([^"]+)"/,
    "RUN_LEDGER_DIRECTORY",
  );

  // Host pusė ji laiko su paketo prefiksu, nes skaito iš repo šaknies, o paketas — be jo.
  assert.equal(
    BENCHMARK_RUN_LEDGER_DIRECTORY,
    `${BENCHMARK_PACKAGE_RELATIVE_PATH}/${packageValue}`,
    "release vartai ieškotų ledger'ių ne ten, kur paketas juos rašo",
  );
  assert.equal(
    RUN_IDENTITY_RELATIVE_DIRECTORY,
    `${BENCHMARK_PACKAGE_RELATIVE_PATH}/${packageValue}`,
    "kompresijos vartai skenuotų kitą katalogą nei benchmark vartai",
  );
});

test("persakyta identity sidecar'o priesaga sutampa visose trijose vietose", async () => {
  const packageValue = await declared(
    LEDGER_STORE,
    /export const RUN_IDENTITY_SUFFIX = "([^"]+)"/,
    "RUN_IDENTITY_SUFFIX",
  );

  assert.equal(RUN_IDENTITY_SUFFIX, packageValue);
  assert.equal(COMPRESSION_RUN_IDENTITY_SUFFIX, packageValue);
});

test("persakytas ledger'io vardo šablonas yra TAS PATS regex", async () => {
  const packageValue = await declared(
    LEDGER_STORE,
    /const LEDGER_NAME_PATTERN = (\/.+\/);/,
    "LEDGER_NAME_PATTERN",
  );
  const hostValue = await declared(
    PROVENANCE,
    /const RUN_LEDGER_NAME = (\/.+\/);/,
    "RUN_LEDGER_NAME",
  );

  // Lyginamas šaltinio tekstas, ne elgsena: du regex'ai gali sutapti visose išbandytose eilutėse
  // ir išsiskirti ties ta, kurios niekas neišbandė. Vienodas tekstas tokios spragos neturi.
  assert.equal(
    hostValue,
    packageValue,
    "vartai atpažintų kitokį ledger'io vardą nei paketas kuria",
  );

  // Ir abu privalo priimti tikrą vardą bei atmesti šalutinį pėdsaką, gulintį tame pačiame
  // kataloge: sutapimas su neteisingu šablonu būtų sutapimas be vertės.
  const pattern = new RegExp(hostValue.slice(1, -1));
  assert.ok(pattern.test("run-20260822t141440313z.jsonl"));
  assert.ok(!pattern.test("run-20260822t141440313z.unmeasured.jsonl"));
  assert.ok(!pattern.test("run-20260822t141440313z.identity.json"));
  assert.ok(!pattern.test("run-20260822t141440313z.claim"));
});
