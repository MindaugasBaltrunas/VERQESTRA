import { describe, expect, it } from "vitest";
import { FRESHNESS_STALE_AFTER_MS, resolveFreshness } from "./FreshnessIndicator";

/**
 * Operatoriaus radinys (2026-08-24): „Gyvi duomenys" konfliktavo su „Pasenusia užduoties būsena"
 * tame pačiame ekrane.
 *
 * Šaknis nebuvo tekstas: ženklelis buvo BESĄLYGIŠKAS literalas, tvirtinęs šviežumą net nutrūkus
 * srautui ir net nepavykus paskutiniam atnaujinimui. Šie testai laiko taisyklę, kad žodis
 * „gyvi" yra užsitarnaujamas, o ne rašomas.
 */

const NOW = Date.parse("2026-08-24T10:00:00.000Z");
const base = { status: "live" as const, refreshFailed: false, loadedAt: NOW - 5_000, now: NOW };

describe("resolveFreshness", () => {
  it("šviežias pollingas su gyvu srautu — ir tik jis — yra `live`", () => {
    expect(resolveFreshness(base)).toEqual({ state: "live", ageSeconds: 5 });
  });

  it("nepavykęs atnaujinimas nugali VISKĄ, įskaitant gyvą srautą", () => {
    // Tai stipriausias signalas: ekranas nebeatitinka serverio, ir jokia srauto būsena to
    // nepaneigia.
    expect(resolveFreshness({ ...base, refreshFailed: true }).state).toBe("failed");
  });

  it("nutrūkęs srautas atima žodį „gyvi", bet duomenų neteisingais nedaro", () => {
    expect(resolveFreshness({ ...base, status: "disconnected" }).state).toBe("stale");
  });

  it("praleisti du pollingai paverčia duomenis pasenusiais", () => {
    // Vienas praleistas 30 s ratas yra tinklo mikčiojimas, o ne pasenę duomenys.
    expect(resolveFreshness({ ...base, loadedAt: NOW - 40_000 }).state).toBe("live");
    expect(resolveFreshness({ ...base, loadedAt: NOW - FRESHNESS_STALE_AFTER_MS - 1 }).state).toBe("stale");
  });

  it("kol nė karto nepavyko — `connecting`, o ne melagingas šviežumas", () => {
    expect(resolveFreshness({ ...base, loadedAt: null })).toEqual({ state: "connecting", ageSeconds: null });
  });

  it("amžius niekada nėra neigiamas (laikrodžių nesutapimas)", () => {
    expect(resolveFreshness({ ...base, loadedAt: NOW + 5_000 }).ageSeconds).toBe(0);
  });
});
