import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nContext";
import { TokenUsageFilterBar, type TokenUsageFilterBarProps } from "./TokenUsageFilterBar";

/**
 * 110 (UI auditas 2026-08-31, P3: „LT datos laukai vis dar rodo mm/dd/yyyy").
 *
 * Naršyklės `<input type="date">` išvaizdos valdyti negalima, tad testai NETIKRINA picker'io —
 * jie saugo tai, ką pasirinkome vietoje kovos su juo: ekrane nebelieka dviejų prieštaraujančių
 * formatų. Matomas ĮVESTIES laukas (naršyklės tvarka) ir šalia jo — REIKŠMĖ, kuri keliauja į
 * filtrą (visada ISO); pagalbinis tekstas kalba tik apie tą reikšmę.
 *
 * jsdom `input[type=date]` `value` priima ISO eilutę, tad įvesties kelias čia tikras.
 */

function renderBar(overrides: Partial<TokenUsageFilterBarProps> = {}) {
  const props: TokenUsageFilterBarProps = {
    model: "",
    phase: "",
    taskIdQuery: "",
    from: "",
    to: "",
    modelOptions: [],
    phaseOptions: [],
    onModelChange: vi.fn(),
    onPhaseChange: vi.fn(),
    onTaskIdQueryChange: vi.fn(),
    onFromChange: vi.fn(),
    onToChange: vi.fn(),
    onDatePreset: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  };
  render(
    <I18nProvider>
      <TokenUsageFilterBar {...props} />
    </I18nProvider>,
  );
  return props;
}

describe("TokenUsageFilterBar datos laukai", () => {
  // Kalba imama iš `localStorage`; be išvalymo šie testai priklausytų nuo svetimo įrašo.
  beforeEach(() => localStorage.clear());

  it("pasirinkus datą šalia lauko rodo faktinę ISO reikšmę", () => {
    renderBar({ from: "2026-06-01", to: "2026-06-30" });

    const fromValue = document.getElementById("token-usage-from-iso");
    const toValue = document.getElementById("token-usage-to-iso");
    expect(fromValue).toHaveTextContent("2026-06-01");
    expect(toValue).toHaveTextContent("2026-06-30");

    // Reikšmė prieinama ir per skaityklę: laukas ją nurodo kaip savo aprašą.
    expect(screen.getByLabelText("Nuo")).toHaveAttribute(
      "aria-describedby",
      "token-usage-from-iso token-usage-date-format",
    );
  });

  it("tuščio filtro ISO eilutės nerodo — nėra ką rodyti", () => {
    renderBar();

    expect(document.getElementById("token-usage-from-iso")).toBeNull();
    expect(document.getElementById("token-usage-to-iso")).toBeNull();
    expect(screen.getByLabelText("Nuo")).toHaveAttribute("aria-describedby", "token-usage-date-format");
  });

  it("pagalbinis tekstas kalba apie siunčiamą reikšmę, o ne apie lauko išvaizdą", () => {
    renderBar({ from: "2026-06-01" });

    const hint = document.getElementById("token-usage-date-format");
    expect(hint).toHaveTextContent("Filtras siunčiamas YYYY-MM-DD formatu");
    // Būtent šis teiginys ir prieštaravo matomam `mm/dd/yyyy` laukui.
    expect(hint?.textContent ?? "").not.toContain("Datos formatas");
  });

  it("datos pakeitimas vis tiek grąžina ISO reikšmę filtrų būsenai", () => {
    const props = renderBar({ from: "2026-06-01" });

    fireEvent.change(screen.getByLabelText("Nuo"), { target: { value: "2026-07-15" } });

    expect(props.onFromChange).toHaveBeenCalledWith("2026-07-15");
  });
});
