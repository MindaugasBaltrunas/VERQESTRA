import type { Route } from "../../controller/useRoute";
import { useThemeController } from "../../controller/useThemeController";
import { useI18n } from "../../i18n/I18nContext";
import { useEffect, useRef } from "react";

export type { Route };

type Props = {
  root: string;
  onRefresh: () => void;
  activeRoute: Route;
  onNavigate: (route: Route) => void;
  onResumeLoop?: () => void;
  resumeLoopLabel?: string;
  onStopLoop?: () => void;
  stopLoopLabel?: string;
  canResumeLoop?: boolean;
  canStopLoop?: boolean;
};

export function Header({
  root,
  onRefresh,
  activeRoute,
  onNavigate,
  onResumeLoop,
  resumeLoopLabel,
  onStopLoop,
  stopLoopLabel,
  canResumeLoop = true,
  canStopLoop = true,
}: Props) {
  const { language, setLanguage, t } = useI18n();
  const navigationRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const navigation = navigationRef.current;
    const active = navigation?.querySelector<HTMLElement>(".nav-tab.active");
    if (!navigation || !active || navigation.scrollWidth <= navigation.clientWidth) return;
    navigation.scrollTo({
      left: active.offsetLeft - (navigation.clientWidth - active.clientWidth) / 2,
      behavior: "smooth",
    });
  }, [activeRoute]);
  return (
    <header>
      <div className="topbar">
        <div className="brand brand-row">
          <div className="app-mark">AG</div>
          <div>
            <h1>VERQESTRA</h1>
            <div className="muted">{root}</div>
          </div>
        </div>
        <nav ref={navigationRef} className="nav-tabs" aria-label={t("Primary navigation")}>
          {([
            ["overview", "Overview", "⌂"],
            ["tasks", "Tasks", "✓"],
            ["reviews", "Reviews", "◇"],
            ["learning", "Learning", "↗"],
            ["analytics", "Analytics", "⌁"],
            ["optimization", "Optimization", "△"],
            ["reliability", "Reliability", "◫"],
            ["benchmark", "Benchmark", "⏱"],
            ["system", "System", "⚙"],
          ] as const).map(([route, label, icon]) => (
            <button
              key={route}
              className={"nav-tab" + (activeRoute === route ? " active" : "")}
              type="button"
              aria-current={activeRoute === route ? "page" : undefined}
              onClick={() => onNavigate(route)}
            >
              <span aria-hidden="true">{icon}</span>
              {t(label)}
            </button>
          ))}
        </nav>
        <div className="toolbar">
          {onResumeLoop && (
            <button className="button success small-button" type="button" onClick={onResumeLoop} title={t("Start VERQESTRA")} disabled={!canResumeLoop}>
              {t(resumeLoopLabel ?? "▶ Start loop")}
            </button>
          )}
          {onStopLoop && (
            <button className="button danger small-button" type="button" onClick={onStopLoop} title={t("Stop VERQESTRA")} disabled={!canStopLoop}>
              {t(stopLoopLabel ?? "⏹ Stop loop")}
            </button>
          )}
          {(onResumeLoop || onStopLoop) && <span className="toolbar-divider" aria-hidden="true" />}
          <button className="button ghost small-button" type="button" onClick={onRefresh} title={t("Refresh data")}>
            ↻ {t("Refresh")}
          </button>
          <div className="language-switch" role="group" aria-label={t("Language")}>
            <button className={`button ghost small-button${language === "lt" ? " active" : ""}`} type="button" onClick={() => setLanguage("lt")} aria-pressed={language === "lt"}>LT</button>
            <button className={`button ghost small-button${language === "en" ? " active" : ""}`} type="button" onClick={() => setLanguage("en")} aria-pressed={language === "en"}>EN</button>
          </div>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useThemeController();
  const { t } = useI18n();

  return (
    <button
      className="button ghost small-button"
      type="button"
      onClick={toggleTheme}
      title={t("Switch theme")}
    >
      {theme === "dark" ? `☀ ${t("Light")}` : `🌙 ${t("Dark")}`}
    </button>
  );
}
