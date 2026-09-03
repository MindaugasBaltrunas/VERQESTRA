import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, useI18n } from "../../../../i18n/I18nContext";
import { TokenBudgetPanel } from "../../../../view/components/tokens/TokenBudgetPanel";

/**
 * 053: `TokenBudgetPanel` skaičių formatavimas anksčiau ėjo per modulio lygio, prikaltą
 * `Intl.NumberFormat("lt-LT")`, nepaisant aktyvaus locale. Šis testas fiksuoja, kad pakeitus
 * aktyvų locale keičiasi skaičiaus atvaizdavimas.
 */

function LanguageSwitch() {
  const { setLanguage } = useI18n();
  return (
    <button type="button" onClick={() => setLanguage("en")}>
      switch-to-en
    </button>
  );
}

describe("TokenBudgetPanel locale", () => {
  beforeEach(() => localStorage.clear());

  it("skaičių atvaizdavimas seka aktyvų locale, ne prikaltą lt-LT", () => {
    const billableTokens = 1_234_567;
    const ltFormatted = new Intl.NumberFormat("lt-LT").format(billableTokens);
    const enFormatted = new Intl.NumberFormat("en-US").format(billableTokens);
    // Aplinkos ICU duomenų sanity patikra: jei jie sutaptų, testas nieko neįrodytų.
    expect(ltFormatted).not.toBe(enFormatted);

    const { container } = render(
      <I18nProvider>
        <LanguageSwitch />
        <TokenBudgetPanel
          budget={{
            budget_enforcement: {
              ok: true,
              billable_tokens: billableTokens,
              total_llm_calls: 3,
            },
          }}
        />
      </I18nProvider>,
    );

    expect(container.textContent).toContain(ltFormatted);

    fireEvent.click(container.querySelector("button")!);

    expect(container.textContent).toContain(enFormatted);
    expect(container.textContent).not.toContain(ltFormatted);
  });

  it("`limitText` riba seka aktyvų locale", () => {
    const maxTotalTokens = 1_234_567;
    const ltFormatted = new Intl.NumberFormat("lt-LT").format(maxTotalTokens);
    const enFormatted = new Intl.NumberFormat("en-US").format(maxTotalTokens);
    expect(ltFormatted).not.toBe(enFormatted);

    const { container } = render(
      <I18nProvider>
        <LanguageSwitch />
        <TokenBudgetPanel
          budget={{
            budget_enforcement: {
              ok: true,
              billable_tokens: 0,
              total_llm_calls: 0,
              limits: { max_llm_calls: null, max_total_llm_calls: null, max_total_tokens: maxTotalTokens },
            },
          }}
        />
      </I18nProvider>,
    );

    expect(container.textContent).toContain(ltFormatted);

    fireEvent.click(container.querySelector("button")!);

    expect(container.textContent).toContain(enFormatted);
    expect(container.textContent).not.toContain(ltFormatted);
  });
});
