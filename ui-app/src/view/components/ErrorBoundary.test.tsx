import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * Ribos testai (2026-08-24 audito ketvirtas ratas — spraga MANO PAČIO pirmo rato darbe).
 *
 * `ErrorBoundary` buvo pridėtas kaip paskutinė riba tarp renderio klaidos ir TUŠČIO EKRANO — t. y.
 * tiksliai to gedimo, dėl kurio visas šis auditas prasidėjo. Ir jis neturėjo NĖ VIENO testo.
 * Neištestuotas saugumo tinklas yra prielaida, ne riba: React klaidų riba nutyla, jei
 * `getDerivedStateFromError` netyčia nustoja būti `static`, o vienintelis požymis būtų baltas
 * puslapis — būtent tas, kurio riba ir neturi leisti.
 *
 * MONTUOJAMA RANKA (`createRoot`), o ne per `@testing-library/react#render`, dėl vienos
 * priežasties: React 19, nukritus konkurenciniam renderiui, atsigauna perrenderindamas šaknį
 * SINCHRONIŠKAI ir apie tai praneša per `onRecoverableError`, kuris jsdom'e keliauja į
 * `window.onerror` ir testą nuverčia. Tai React DIAGNOSTIKA apie savo paties atsigavimą, ne
 * programos klaida — programos klaidą gaudo pati riba, ir būtent ją čia ir tikriname. RTL
 * `render` šio parametro neatiduoda, tad šaknis kuriama tiesiogiai.
 */

/** Meta pagal IŠORINĮ jungiklį: React tą patį medį gali renderinti dukart, tad sprendimas privalo būti stabilus. */
function Fragile({ throws }: { throws: () => boolean }) {
  if (throws()) throw new Error("stopStatus is undefined");
  return <p>turinys atkurtas</p>;
}

let root: Root | undefined;
let container: HTMLElement | undefined;

function mount(ui: ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLElement, { onRecoverableError: () => {} });
    root.render(ui);
  });
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    // React klaidą loguoja pats; be stub'o testų išvestis pasidaro neįskaitoma. Tikras
    // `console.error` kvietimas iš `componentDidCatch` tikrinamas atskiru testu.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
  });

  it("renderio klaida virsta MATOMU pranešimu, o ne tuščiu ekranu", () => {
    mount(
      <ErrorBoundary>
        <Fragile throws={() => true} />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    // Žinutė privalo nešti KLAIDOS tekstą ir VEIKSMĄ: „kažkas nepavyko" operatoriui neduoda nieko.
    expect(alert.textContent).toContain("stopStatus is undefined");
    expect(alert.textContent).toContain("pnpm build");
  });

  it("sveikas medis pro ribą praeina nepaliestas", () => {
    mount(
      <ErrorBoundary>
        <Fragile throws={() => false} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("turinys atkurtas")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("pakartojimo mygtukas realiai atstato medį", () => {
    let broken = true;
    mount(
      <ErrorBoundary>
        <Fragile throws={() => broken} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    broken = false;
    const retry = screen.getByRole("button", { name: /Bandyti dar kartą/ });
    act(() => retry.click());

    // Mygtukas be realaus atstatymo būtų blogesnis už jokį: jis žada veiksmą, kurio nėra.
    expect(screen.getByText("turinys atkurtas")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("klaida NEPRARYJAMA — konsolėje lieka pėdsakas", () => {
    mount(
      <ErrorBoundary>
        <Fragile throws={() => true} />
      </ErrorBoundary>,
    );

    // Žinutė ekrane pasako KAS lūžo; be konsolės eilutės su komponentų stack'u niekas nepasakytų KUR.
    const logged = vi.mocked(console.error).mock.calls;
    expect(logged.some((args) => args[0] === "[vq-ui] render failed")).toBe(true);
  });
});
