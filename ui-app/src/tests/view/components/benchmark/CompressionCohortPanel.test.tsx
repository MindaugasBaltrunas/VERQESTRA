import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CompressionCohortPanel } from "../../../../view/components/benchmark/CompressionCohortPanel";
import type {
  BenchmarkCompressionSection,
  BenchmarkCompressionVariant,
} from "../../../../model/types";

// Panelė nieko neskaičiuoja, todėl tikrinama ne aritmetika, o TEIGINIAI: ką ji sako, kai duomenų
// nėra, ir ar nepaverčia „nematuota" į „nulis". Būtent tas pavertimas yra vienintelis būdas šiai
// panelei meluoti.
//
// `I18nProvider` čia nededamas sąmoningai: be jo `t()` grąžina anglišką raktą, tad testas mato
// tekstą, kurio ieško, ir nesilaužo pakeitus vertimą.

function variant(overrides: Partial<BenchmarkCompressionVariant> = {}): BenchmarkCompressionVariant {
  return {
    variantId: "baseline",
    variantIdentity: "baseline@1",
    features: [],
    hookProfile: "none",
    sampleCount: 4,
    conclusiveCount: 4,
    capturedUsageCount: 4,
    verdict: "accepted",
    reasons: [],
    usage: {},
    diagnostics: [],
    ...overrides,
  };
}

function section(overrides: Partial<BenchmarkCompressionSection> = {}): BenchmarkCompressionSection {
  return {
    registryVersion: 1,
    costKpiVersion: 2,
    baselineVariantId: "baseline",
    variants: [variant()],
    unattributedSampleCount: 0,
    limitations: [],
    ...overrides,
  };
}

describe("CompressionCohortPanel", () => {
  it("nesuvestos kohortos NEPIEŠIA kaip nulinio rezultato", () => {
    const { container } = render(<CompressionCohortPanel section={undefined} />);
    // Tuščia lentelė būtų perskaityta kaip „kompresija nieko nedavė"; sekcijos nebuvimas to
    // neteigia, todėl teisingas atsakymas yra tyla.
    expect(container.innerHTML).toBe("");
  });

  it("nematuotą KPI rodo kaip bruksnį, o ne kaip nulį", () => {
    render(<CompressionCohortPanel section={section()} />);

    // Per `rowheader`, o ne per `row`: stulpelio antraštė „Delta vs baseline" irgi sutampa su
    // /baseline/, ir eilutės paieška pagal vardą pagautų abi.
    const row = screen.getByRole("rowheader", { name: /baseline/ }).closest("tr");
    expect(row?.textContent).toContain("—");
    // Nulis reikštų IŠMATUOTĄ nulinę kainą — priešingą teiginį nei „duomenų nėra".
    expect(row?.textContent).not.toMatch(/\b0\b/);
  });

  it("verdikto priežastis rodo kaip kodus, neišverstas", () => {
    render(
      <CompressionCohortPanel
        section={section({
          variants: [
            variant(),
            variant({
              variantId: "canary",
              verdict: "rejected",
              reasons: ["security-failure-rate-regressed"],
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText("security-failure-rate-regressed")).toBeTruthy();
  });

  it("nepriskirtus bandymus įvardija, o ne nutyli", () => {
    render(<CompressionCohortPanel section={section({ unattributedSampleCount: 3 })} />);
    // Tylėjimas parodytų dalinę imtį kaip pilną.
    expect(screen.getByRole("status").textContent).toContain("3");
  });

  it("apribojimus rodo kartu su skaičiais", () => {
    const limitation = "Single run; no statistical power.";
    render(<CompressionCohortPanel section={section({ limitations: [limitation] })} />);
    expect(screen.getByText(limitation)).toBeTruthy();
  });

  it("nepaleisto vieno požymio varianto indėlio NEIŠVEDA iš derinio", () => {
    render(
      <CompressionCohortPanel
        section={section({
          combination: {
            variantId: "all-features",
            featureContributions: [{ feature: "prune", variantId: "" }],
            observedCombinationContribution: 1200,
          },
        })}
      />,
    );

    // Atimtis iš derinio paskelbtų aritmetinę tapatybę kaip matavimą.
    expect(screen.getByText(/no single-feature variant was run/)).toBeTruthy();
  });
});
