import { useRoute } from "../controller/useRoute";
import { DashboardPage } from "./pages/DashboardPage";
import { TokenUsagePage } from "./pages/TokenUsagePage";
import { ReliabilityPage } from "./pages/ReliabilityPage";
import { BenchmarkPage } from "./pages/BenchmarkPage";
import { I18nProvider } from "../i18n/I18nContext";

export function AppRoot() {
  return <I18nProvider><RoutedApp /></I18nProvider>;
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
