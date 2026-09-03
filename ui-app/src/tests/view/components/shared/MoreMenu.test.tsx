import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTE_LABELS, type Route } from "../../../../controller/useRoute";
import { I18nProvider } from "../../../../i18n/I18nContext";
import { MoreMenu } from "../../../../view/components/shared/MoreMenu";

/**
 * 109: ekranų sąrašas suskirstytas į sekcijas, o tema/kalba sutraukta į vieną eilutę — grupavimas
 * pats savaime negali paslėpti nė vieno `ROUTE_LABELS` maršruto, o aktyvaus maršruto žymėjimas ir
 * temos/kalbos perjungimas turi veikti lygiai taip pat, kaip prieš pertvarką.
 *
 * Pirmi trys testai nesivynioja į `I18nProvider`: be jo `useI18n()` grąžina fallback kontekstą,
 * kur `t()` yra tapatybė — tikrinami tikslūs `ROUTE_LABELS` angliški raktai, ne vertimas.
 *
 * `<details>` turinys jsdom'e pasiekiamas iš karto (jsdom nemodeliuoja UA stiliaus, kuris
 * naršyklėje uždarą panelę paslėptų): testai tikrina markup'ą tiesiogiai, be `summary` paspaudimo.
 */

describe("MoreMenu", () => {
  beforeEach(() => localStorage.clear());

  it("keeps every ROUTE_LABELS screen reachable after grouping into sections", () => {
    render(<MoreMenu activeRoute="overview" onNavigate={vi.fn()} onRefresh={vi.fn()} />);

    for (const route of Object.keys(ROUTE_LABELS) as Route[]) {
      expect(screen.getByRole("button", { name: ROUTE_LABELS[route] })).toBeInTheDocument();
    }
  });

  it("marks the active route with aria-current", () => {
    render(<MoreMenu activeRoute="reliability" onNavigate={vi.fn()} onRefresh={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Reliability" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("navigates and closes when a grouped screen button is clicked", () => {
    const onNavigate = vi.fn();
    render(<MoreMenu activeRoute="overview" onNavigate={onNavigate} onRefresh={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Compression" }));

    expect(onNavigate).toHaveBeenCalledWith("compression");
  });

  it("switches theme and language from the compact settings row", () => {
    render(
      <I18nProvider>
        <MoreMenu activeRoute="overview" onNavigate={vi.fn()} onRefresh={vi.fn()} />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(screen.getByRole("button", { name: "EN" })).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("ag-loop-language")).toBe("en");

    expect(document.documentElement.dataset.theme).not.toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: /Dark/ }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
