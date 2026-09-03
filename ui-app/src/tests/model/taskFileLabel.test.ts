import { describe, expect, it } from "vitest";
import { taskFileLabel } from "../../model/taskFileLabel";

/**
 * 2026-08-24, operatoriaus nurodymas: „Trumpinti failus iki užduoties ID ir pavadinimo; visą kelią
 * palikti detalėse."
 *
 * Trumpinimas turi ribą: jis nukerpa TRIUKŠMĄ (plėtinį, kelią, brūkšnelius), bet niekada —
 * skiriamosios dalies. Todėl kiekvienas atvejis čia tikrina, kad ID lieka atskiras ir tikslus.
 */
describe("taskFileLabel", () => {
  it("atskiria ID nuo pavadinimo ir nuima plėtinį", () => {
    expect(taskFileLabel("0042-perkelti-loop-varikli.md")).toEqual({ id: "0042", name: "perkelti loop varikli" });
  });

  it("vaiko užduoties sudėtinis ID lieka VIENAS vienetas", () => {
    // `0042-02` yra tapatybė, ne „0042 plius 02": suskaldytas jis nurodytų į tėvą.
    expect(taskFileLabel("0042-02-vaikas.md")).toEqual({ id: "0042-02", name: "vaikas" });
  });

  it("vardas be skaitinio prefikso ID neįgyja", () => {
    // Atlaidus „bet kas iki pirmo brūkšnelio" paverstų `readme-guard` ID `readme` — ir sąrašas
    // rodytų tapatybę, kurios nėra.
    expect(taskFileLabel("readme-guard.md")).toEqual({ id: null, name: "readme-guard" });
  });

  it("vardas be aprašomosios dalies grąžina patį ID, o ne tuščią eilutę", () => {
    expect(taskFileLabel("0042.md")).toEqual({ id: "0042", name: "0042" });
  });

  it("kelias nukerpamas abiem separatoriais", () => {
    // `humanReview.file` ateina posix forma, bucket'ų sąrašai — jau vardais.
    expect(taskFileLabel("AG/tasks/queue/0007-abc.md").id).toBe("0007");
    expect(taskFileLabel("AG\\tasks\\queue\\0007-abc.md").id).toBe("0007");
  });

  it("pabraukimai irgi virsta tarpais", () => {
    expect(taskFileLabel("0013-du_zodziai.md").name).toBe("du zodziai");
  });
});
