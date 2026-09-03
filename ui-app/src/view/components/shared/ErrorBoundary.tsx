import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Paskutinė riba tarp renderio klaidos ir TUŠČIO EKRANO.
 *
 * 2026-08-23 UI paleidimo auditas: serverio kontrakto nesutapimas nulaužė vaizdo modelį prieš
 * pirmą renderį, React išmontavo visą medį, ir operatorius gaudavo baltą puslapį be jokios
 * nuorodos, kas atsitiko. Tuščias ekranas yra blogesnis už klaidą: iš jo neįmanoma nei suprasti
 * gedimo, nei jo pranešti.
 *
 * Riba SĄMONINGAI neslepia klaidos: žinutė rodoma, o `componentDidCatch` ją palieka konsolėje
 * su komponentų stack'u. Tai diagnostikos produktas — tyli baigtis čia būtų defektas.
 *
 * Tekstas čia NEVERČIAMAS per `t()`: riba privalo veikti ir tada, kai lūžo pats i18n
 * kontekstas, o vertimo hook'o kvietimas tokiu atveju būtų antras griuvimas ant pirmojo.
 */

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { error: Error | null };

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Konsolė yra vienintelė vieta, kur lieka komponentų stack'as — be jo žinutė ekrane pasako
    // KAS lūžo, bet ne KUR.
    console.error("[vq-ui] render failed", error, info.componentStack);
  }

  override render(): ReactNode {
    const error = this.state.error;
    if (error === null) return this.props.children;

    return (
      <main>
        <div className="panel" style={{ color: "var(--error)" }} role="alert">
          <strong>Dashboard nepavyko atvaizduoti / Dashboard failed to render</strong>
          <p style={{ marginTop: "0.75rem" }}>{error.message}</p>
          <p style={{ marginTop: "0.75rem", color: "var(--muted)" }}>
            Naršyklės konsolėje yra pilnas pėdsakas. Jei ką tik atnaujinai kodą — perkrauk UI
            serverį (<code>pnpm build</code>, tada paleisk <code>verqestra ui</code> iš naujo).
          </p>
          <button
            className="button ghost small-button"
            style={{ marginTop: "1rem" }}
            type="button"
            onClick={() => this.setState({ error: null })}
          >
            Bandyti dar kartą / Try again
          </button>
        </div>
      </main>
    );
  }
}
