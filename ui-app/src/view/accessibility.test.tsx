import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoot } from "./AppRoot";

/**
 * Prieinamumo vartai (2026-08-24 UI audito ketvirtas ratas — originalaus audito rekomendacija 4).
 *
 * Abu tikrinami dalykai yra ne stiliaus klausimas, o kliūtis, kurią galima išmatuoti:
 *
 *   - WCAG 2.4.1 „Bypass Blocks": kiekviename maršrute prieš turinį stovi 9 navigacijos skirtukai
 *     ir 6 įrankių juostos mygtukai. Klaviatūra dirbančiam operatoriui tai 15 `Tab` paspaudimų
 *     iki KIEKVIENO ekrano.
 *   - WCAG 2.4.2 „Page Titled": SPA be antraštės atnaujinimo palieka vieną statinę antraštę
 *     visiems ekranams, tad naršyklės istorija ir kortelių juosta tampa neskaitomos.
 */

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      // Srautas testuose sąmoningai neprisijungia; puslapis nuo to nenukenčia.
      if (url.includes("/api/events")) return Promise.reject(new Error("sse disabled in tests"));
      return Promise.resolve(
        new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
      );
    }),
  );
}

describe("prieinamumas: navigacijos praleidimas ir dokumento antraštė", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubFetch();
    window.location.hash = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = "";
  });

  it("praleidimo mygtukas yra PIRMAS fokusuojamas elementas ir perkelia fokusą į `main`", async () => {
    const { container } = render(<AppRoot />);

    const skip = screen.getByRole("button", { name: "Pereiti prie turinio" });
    // „Pirmas Tab" tikrinamas per DOM tvarką: jsdom klaviatūros navigacijos neįgyvendina, tad
    // fokusuojamų elementų seka yra tiksliai tas pats faktas, tik be simuliacijos sluoksnio.
    const focusable = container.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    expect(focusable[0]).toBe(skip);

    fireEvent.click(skip);
    // Turinys gauna fokusą, tad kitas `Tab` tęsia NUO turinio, o ne nuo navigacijos pradžios.
    await waitFor(() => expect(document.querySelector("main")).toHaveFocus());
  });

  it("praleidimo mygtukas NEKEIČIA maršruto", async () => {
    render(<AppRoot />);

    fireEvent.click(screen.getByRole("button", { name: "Pereiti prie turinio" }));
    // Įprastas `<a href="#main-content">` šablonas čia perrašytų hash'ą, `readRoute` jo
    // neatpažintų, ir operatorius vietoj turinio atsidurtų „Apžvalgoje" — tyliai sulaužyta
    // navigacija vietoje prieinamumo pagerinimo.
    expect(window.location.hash).toBe("");
  });

  it("dokumento antraštė seka maršrutą", async () => {
    render(<AppRoot />);
    await waitFor(() => expect(document.title).toBe("Apžvalga — VERQESTRA"));

    window.location.hash = "/system";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(document.title).toBe("Sistema — VERQESTRA"));
  });
});
