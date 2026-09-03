import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ROUTE_LABELS, useRoute, type Route } from "../../controller/useRoute";

// Visi žinomi maršrutai — testų sąrašas sutampa su `Route` sąjunga `useRoute.ts` viduje. Jei
// ateityje pridedamas naujas maršrutas be jo įtraukimo čia, `gate` testas apačioje vis tiek
// pagaus trūkstamą `ROUTE_LABELS` įrašą (žr. jo komentarą apie 2026-08-26 `compression`).
const KNOWN_ROUTES: Route[] = [
  "overview",
  "tasks",
  "reviews",
  "learning",
  "analytics",
  "optimization",
  "reliability",
  "benchmark",
  "compression",
  "system",
];

function setHash(hash: string) {
  window.location.hash = hash;
}

describe("useRoute", () => {
  afterEach(() => {
    setHash("");
  });

  it("hash be `#/` prefikso grąžina overview", () => {
    // `window.location.hash = "overview"` naršyklėje virsta `#overview`, ne `#/overview` — tokia
    // reikšmė neatitinka `#/<route>` formato, todėl turi kristi į numatytą maršrutą.
    setHash("overview");
    const { result } = renderHook(() => useRoute());
    expect(result.current.route).toBe("overview");
  });

  it("nežinomas maršrutas grąžina overview, ne klaidą", () => {
    setHash("#/does-not-exist");
    const { result } = renderHook(() => useRoute());
    expect(result.current.route).toBe("overview");
  });

  it.each(KNOWN_ROUTES)("atpažįsta hash'ą #/%s", (route) => {
    setHash(`#/${route}`);
    const { result } = renderHook(() => useRoute());
    expect(result.current.route).toBe(route);
  });

  it("navigate('overview') išvalo hash'ą", () => {
    setHash("#/tasks");
    const { result } = renderHook(() => useRoute());

    act(() => result.current.navigate("overview"));

    expect(window.location.hash).toBe("");
  });

  it.each(KNOWN_ROUTES.filter((route) => route !== "overview"))(
    "navigate('%s') rašo #/%s",
    (route) => {
      const { result } = renderHook(() => useRoute());

      act(() => result.current.navigate(route));

      expect(window.location.hash).toBe(`#/${route}`);
    },
  );

  it("hashchange event'as atnaujina hook'o būseną", () => {
    setHash("#/tasks");
    const { result } = renderHook(() => useRoute());
    expect(result.current.route).toBe("tasks");

    act(() => {
      setHash("#/system");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(result.current.route).toBe("system");
  });

  // Vartas: kiekvienas `Route` sąjungos variantas privalo turėti `ROUTE_LABELS` įrašą. Be šio
  // varto naujas maršrutas gali būti pridėtas prie tipo, bet praleistas etiketėse — navigacija
  // veiktų, bet skirtukas ir dokumento antraštė liktų tušti / "undefined".
  it("gate: ROUTE_LABELS turi įrašą kiekvienam Route variantui", () => {
    for (const route of KNOWN_ROUTES) {
      expect(ROUTE_LABELS[route]).toBeTruthy();
      expect(typeof ROUTE_LABELS[route]).toBe("string");
    }
    expect(Object.keys(ROUTE_LABELS).sort()).toEqual([...KNOWN_ROUTES].sort());
  });
});
