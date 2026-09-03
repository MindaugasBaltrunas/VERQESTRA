import { describe, expect, it } from "vitest";
import { fill } from "../../model/fillTemplate";

describe("fill", () => {
  it("esantis raktas pakeičiamas reikšme", () => {
    expect(fill("Hello, {name}!", { name: "World" })).toBe("Hello, World!");
  });

  it("trūkstamas raktas šablone lieka kaip literalus placeholder, ne 'undefined' tekstas", () => {
    // `fill` iteruoja per `values` raktus (Object.entries), o ne per šablono placeholder'ius —
    // rakto, kurio `values` neturi, tiesiog niekas nepakeičia. Rezultate lieka `{missing}`, o ne
    // "undefined" tekstas šalia jo.
    const result = fill("Value: {missing}", { name: "World" });
    expect(result).toBe("Value: {missing}");
    expect(result).not.toContain("undefined");
  });

  it("pasikartojantis raktas pakeičiamas visose vietose", () => {
    expect(fill("{x} + {x} = {sum}", { x: 2, sum: 4 })).toBe("2 + 2 = 4");
  });

  it("tuščias šablonas grąžina tuščią eilutę", () => {
    expect(fill("", { name: "World" })).toBe("");
  });

  it("tuščias values objektas nekeičia šablono", () => {
    expect(fill("{name} stays literal", {})).toBe("{name} stays literal");
  });

  it("specialūs regex simboliai reikšmėje nesugadina pakeitimo", () => {
    expect(fill("Pattern: {pattern}", { pattern: "a.*b$(c)" })).toBe("Pattern: a.*b$(c)");
  });

  it("specialūs regex simboliai rakto viduje nesugadina pakeitimo", () => {
    // Naudojami `split`/`join`, ne `RegExp` — raktas su regex specialiaisiais simboliais
    // (pvz. `a.b`) turi būti traktuojamas kaip pažodinis tekstas, ne kaip šablonas.
    expect(fill("{a.b} value", { "a.b": "matched" })).toBe("matched value");
  });

  it("skaitinė reikšmė paverčiama į string be papildomų simbolių", () => {
    expect(fill("Count: {count}", { count: 0 })).toBe("Count: 0");
  });
});
