import { describe, expect, it } from "vitest";
import { buildLoopControls } from "./useDashboardController";

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

  it("no runtime entry at all: only Start is available (fresh project, loop never ran)", () => {
    expect(buildLoopControls(undefined, START, STOP)).toEqual({ canResume: true, canStop: false });
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
});
