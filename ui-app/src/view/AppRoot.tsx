import { useRoute } from "../controller/useRoute";
import { DashboardPage } from "./pages/DashboardPage";
import { TokenUsagePage } from "./pages/TokenUsagePage";
import { ReliabilityPage } from "./pages/ReliabilityPage";
import { BenchmarkPage } from "./pages/BenchmarkPage";
import { I18nProvider } from "../i18n/I18nContext";
import { ErrorBoundary } from "./components/ErrorBoundary";

/**
 * Riba yra IŠORINIS sluoksnis — virš `I18nProvider`: renderio klaida provider'io viduje
 * išmontuotų ir jį patį, tad riba, gyvenanti giliau, dingtų kartu su ekranu, kurį turi išgelbėti.
 */
export function AppRoot() {
  return (
    <ErrorBoundary>
      <I18nProvider><RoutedApp /></I18nProvider>
    </ErrorBoundary>
  );
}

function RoutedApp() {
  const { route, navigate } = useRoute();

  if (route === "analytics" || route === "optimization") {
    return <TokenUsagePage activeRoute={route} onNavigate={navigate} />;
  }
  if (route === "reliability") return <ReliabilityPage activeRoute={route} onNavigate={navigate} />;
  if (route === "benchmark") return <BenchmarkPage activeRoute={route} onNavigate={navigate} />;

  return <DashboardPage activeRoute={route} onNavigate={navigate} />;
}
