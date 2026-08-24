// `retryCountsStore` — TIKRAS adapteris prieš TIKRĄ failų sistemą.
//
// Kodėl atskirai nuo `interfaces-cli-dispatch`: ten `update` semantika atkartojama FIXTURE'u, tad
// tikrinama domeno taisyklė, o ne adapteris. Būtent adapteryje 2026-08-23 ir buvo rastas
// prieštaravimas — jis sugadintą failą skaitė kaip `{}`, nors porto doc'as reikalauja klaidos, ir
// du deklaruoti kontraktai vienam klausimui tyliai sprendėsi adapterio naudai.
//
// Fixture negali to pagauti iš principo: jis atkartoja tai, ką MANOME adapterį darant. Todėl čia
// naudojama tikra `mkdtemp` šaknis ir tikras `withStateFileLock`.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { retryCountsStore } from "../composition/loop/adapters.js";

async function runtimeRoot(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-retry-counts-"));
  await mkdir(path.join(root, "state"), { recursive: true });
  return { root, file: path.join(root, "state", "retry-counts.json") };
}

test("nesantis failas — tuščias žemėlapis, o ne klaida", async () => {
  const { root } = await runtimeRoot();
  try {
    assert.deepEqual(await retryCountsStore(root).read(), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SUGADINTAS failas META abiejuose keliuose — vartas, kuris negali suskaičiuoti, sustoja", async () => {
  const { root, file } = await runtimeRoot();
  try {
    await writeFile(file, "{ sugadintas", "utf8");
    const store = retryCountsStore(root);

    // `{}` čia reikštų, kad bandymus jau išnaudojęs task'as gauna ŠVIEŽIĄ biudžetą, o retry
    // limitas egzistuoja būtent tam, kad repair kilpa nebūtų begalinė.
    await assert.rejects(() => store.read(), /retry counts file is corrupt/);
    await assert.rejects(() => store.update((counts) => counts), /retry counts file is corrupt/);

    // Sugadintas failas NEPERRAŠOMAS: operatoriaus sprendimas jį ištrinti turi likti sąmoningas,
    // o ne tylus šalutinis efektas.
    assert.equal(await readFile(file, "utf8"), "{ sugadintas");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 2026-08-24 (operatoriaus radinys): `typeof [] === "object"`, tad masyvas praeidavo pro sugadinto
// failo patikrą. `counts["task:x"] = 1` uždėdavo jam VARDINĘ savybę, o `JSON.stringify([])` ją
// numesdavo — failas likdavo `[]`, retry limitas NIEKADA neaugdavo, ir repair kilpa tapdavo
// begalinė. Apsauga buvo apeinama per savo pačios spragą.
test("MASYVAS nėra galiojantis skaitiklių failas", async () => {
  const { root, file } = await runtimeRoot();
  try {
    await writeFile(file, "[]", "utf8");
    const store = retryCountsStore(root);
    await assert.rejects(() => store.read(), /corrupt/);
    await assert.rejects(() => store.update((counts) => counts), /corrupt/);
    assert.equal(await readFile(file, "utf8"), "[]", "sugadintas failas neperrašomas");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ne skaitinė reikšmė yra sugadinimas, o ne nulis", async () => {
  const { root, file } = await runtimeRoot();
  try {
    // `"3" + 1 === "31"`: be šios patikros limitas skaičiuotų ne tai, ką turi.
    await writeFile(file, JSON.stringify({ "task:0042": "3" }), "utf8");
    await assert.rejects(() => retryCountsStore(root).read(), /not a non-negative safe integer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 2026-08-24 (operatoriaus radinys): `Number.isFinite` praleisdavo tris formas, ir kiekviena
// savaip PRAPLĖSDAVO repair biudžetą. Visos trys yra baigtiniai skaičiai — būtent todėl senoji
// patikra jų nematė.
for (const [label, value, why] of [
  ["neigiamas", -5, "`-5 + 1 = -4`: klaidos skaitikliui reikia 7 inkrementų iki 2, o task skaitiklį `Math.max(…, 0)` nutempia į 0 — išnaudotas biudžetas atsistato"],
  ["trupmeninis", 1.5, "ne bandymų skaičius; `Math.floor` žemiau tai užmaskuotų"],
  ["virš MAX_SAFE_INTEGER", 1e300, "`x + 1 === x` — skaitiklis nustoja augti, repair kilpa tampa begaline"],
] as const) {
  test(`${label} skaitiklis yra sugadinimas (${why})`, async () => {
    const { root, file } = await runtimeRoot();
    try {
      await writeFile(file, JSON.stringify({ "task:0042": value }), "utf8");
      const store = retryCountsStore(root);
      // Abu keliai fail-closed: vartai, kurie negali suskaičiuoti, sustoja.
      await assert.rejects(() => store.read(), /not a non-negative safe integer/);
      await assert.rejects(() => store.update((counts) => counts), /not a non-negative safe integer/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("0 ir didelis GALIOJANTIS skaitiklis praeina — patikra neišplėsta per plačiai", async () => {
  const { root, file } = await runtimeRoot();
  try {
    const valid = { "task:0042": 0, "error:x": Number.MAX_SAFE_INTEGER };
    await writeFile(file, JSON.stringify(valid), "utf8");
    assert.deepEqual(await retryCountsStore(root).read(), valid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update grąžina mutacijos rezultatą ir įrašo būseną", async () => {
  const { root, file } = await runtimeRoot();
  try {
    const store = retryCountsStore(root);
    const result = await store.update((counts) => {
      counts["task:0042"] = 3;
      return "verdiktas";
    });

    assert.equal(result, "verdiktas");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { "task:0042": 3 });
    assert.deepEqual(await store.read(), { "task:0042": 3 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lygiagretūs inkrementai NEPRARANDAMI — read-modify-write serializuotas", async () => {
  const { root, file } = await runtimeRoot();
  try {
    const store = retryCountsStore(root);
    await store.update((counts) => void (counts["task:0042"] = 0));

    // Be užrakto abu kvietimai perskaitytų tą pačią reikšmę ties `await readCounts()` ir vienas
    // kito rezultatą perrašytų — limitas leistų daugiau bandymų, nei nustatyta.
    const WRITERS = 8;
    await Promise.all(
      Array.from({ length: WRITERS }, () =>
        store.update((counts) => {
          counts["task:0042"] = (counts["task:0042"] ?? 0) + 1;
        }),
      ),
    );

    const final = JSON.parse(await readFile(file, "utf8")) as Record<string, number>;
    assert.equal(final["task:0042"], WRITERS, `prarasta inkrementų: ${WRITERS - (final["task:0042"] ?? 0)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
