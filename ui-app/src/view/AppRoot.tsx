import { useEffect } from "react";
import { ROUTE_LABELS, useRoute } from "../controller/useRoute";
import { DashboardPage } from "./pages/DashboardPage";
import { TokenUsagePage } from "./pages/TokenUsagePage";
import { ReliabilityPage } from "./pages/ReliabilityPage";
import { BenchmarkPage } from "./pages/BenchmarkPage";
import { CompressionPage } from "./pages/CompressionPage";
import { I18nProvider, useI18n } from "../i18n/I18nContext";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { SkipToContent } from "./components/shared/SkipToContent";

/**
 * Riba yra IŠORINIS sluoksnis — virš `I18nProvider`: renderio klaida provider'io viduje
 * išmontuotų ir jį patį, tad riba, gyvenanti giliau, dingtų kartu su ekranu, kurį turi išgelbėti.
 */
export function AppRoot() {
  return (
    <ErrorBoundary>
      <I18nProvider>
        <SkipToContent />
        <RoutedApp />
      </I18nProvider>
    </ErrorBoundary>
  );
}

function RoutedApp() {
  const { route, navigate } = useRoute();
  const { t } = useI18n();

  /**
   * Dokumento antraštė seka maršrutą (WCAG 2.4.2). SPA be šito palieka vieną statinę antraštę
   * visiems ekranams: naršyklės istorijoje ir kortelių juostoje kiekvienas įrašas atrodo vienodai,
   * o operatorius su keliais atidarytais dashboard'ais neturi jokio būdo atskirti, kuri kortelė
   * ką rodo. Rašytojas VIENAS — kitaip du efektai kovotų dėl to paties lauko.
   */
  useEffect(() => {
    document.title = `${t(ROUTE_LABELS[route])} — VERQESTRA`;
  }, [route, t]);

  if (route === "analytics" || route === "optimization") {
    return <TokenUsagePage activeRoute={route} onNavigate={navigate} />;
  }
  if (route === "reliability") return <ReliabilityPage activeRoute={route} onNavigate={navigate} />;
  if (route === "benchmark") return <BenchmarkPage activeRoute={route} onNavigate={navigate} />;
  if (route === "compression") return <CompressionPage activeRoute={route} onNavigate={navigate} />;

  return <DashboardPage activeRoute={route} onNavigate={navigate} />;
}
