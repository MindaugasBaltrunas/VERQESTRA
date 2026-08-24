import { describe, expect, it } from "vitest";
import { buildLoopControls } from "./useDashboardController";
import { loopActionAllowed, type LoopRunState } from "../model/loopControlsViewModel";

// 2026-08-06: „Sustabdyti ciklą" buvo išjungtas, nors ciklas realiai dirbo. Priežastis — trečioji
// būsena `unknown`: `status !== "running"` darė „Paleisti" aktyvų (UI siūlė paleisti ANTRĄ
// orkestratorių), o `status === "running"` darė „Sustabdyti" išjungtą (veikiančio sustabdyti
// nebuvo galima). Taisyklė: veikia → tik Stop; neveikia → tik Start; nežinoma → saugusis veiksmas.

const START = "▶ Start loop";
const STOP = "⏹ Stop loop";

describe("buildLoopControls", () => {
  it("running loop: only Stop is available", () => {
    expect(buildLoopControls("running", START, STOP)).toEqual({ canResume: false, canStop: true });
  });

  it("stopped loop: only Start is available", () => {
    expect(buildLoopControls("stopped", START, STOP)).toEqual({ canResume: true, canStop: false });
  });

  // 2026-08-24 auditas (dublikatų šluostė). Anksčiau čia stovėjo priešingas lūkestis: „nėra
  // runtime įrašo → leidžiam paleisti (fresh project, loop never ran)". Tas pagrindimas nebegalioja
  // nuo tada, kai serveris `runtime` sąrašą siunčia VISADA — „įrašo nėra" nebereiškia švaraus
  // projekto, o reiškia netvarkingą atsakymą. Be to Header'is taip prasilenkdavo su `#/system`
  // valdikliais, kurie tą pačią nežinomybę visada laikė pavojinga. Dabar taisyklė VIENA.
  it("trūkstamas runtime įrašas virsta `unknown` — paleidimas UŽDARYTAS", () => {
    expect(buildLoopControls("unknown", START, STOP)).toEqual({ canResume: false, canStop: true });
  });

  it("unknown status: Stop stays available, Start does NOT", () => {
    // Stabdymas nekenksmingas (įrašoma vėliava), o antro orkestratoriaus paleidimas tame pačiame
    // repo yra reali žala — todėl neaiškumas sprendžiamas saugumo naudai.
    expect(buildLoopControls("unknown", START, STOP)).toEqual({ canResume: false, canStop: true });
  });

  it("a pending action disables its own button until the label resets", () => {
    expect(buildLoopControls("stopped", "▶ Starting...", STOP).canResume).toBe(false);
    expect(buildLoopControls("running", START, "⏹ Stopping...").canStop).toBe(false);
  });

  // Vartas prieš kopijos atsiradimą iš naujo: Header'is ir `#/system` privalo atsakyti VIENODAI
  // kiekvienai būsenai. Iki suvienodinimo jie skyrėsi ties nežinomybe, ir skirtumo nerodė nė vienas
  // testas — abu tikrino savo pusę atskirai.
  it("gate: Header ir `#/system` leidimai SUTAMPA kiekvienai būsenai", () => {
    const statuses: LoopRunState[] = ["running", "stopped", "unknown"];
    for (const status of statuses) {
      const header = buildLoopControls(status, START, STOP);
      const panel = loopActionAllowed(status);
      expect({ canResume: header.canResume, canStop: header.canStop }).toEqual({
        canResume: panel.start,
        canStop: panel.stop,
      });
    }
  });
});
