import { useMemo, useState } from "react";
import { PolicyProposalsPanel } from "../../App";
import { useDashboardController } from "../../controller/useDashboardController";
import { useWavesController } from "../../controller/useWavesController";
import { fixableTaskIds } from "../../model/loopControlsViewModel";
import { buildSlotProgressViews, correlateActivity } from "../../model/slotProgressViewModel";
import { AgentChainProgress } from "../components/AgentChainProgress";
import { DiagnosticsPanel } from "../components/DiagnosticsPanel";
import { FreshnessIndicator, StreamIndicator } from "../components/FreshnessIndicator";
import { TokenBudgetPanel } from "../components/TokenBudgetPanel";
import { Header, type Route } from "../components/Header";
import { HumanReviewPanel } from "../components/HumanReviewPanel";
import { LearningPanel } from "../components/LearningPanel";
import { OverviewPanel } from "../components/OverviewPanel";
import { PolicyControlsPanel } from "../components/PolicyControlsPanel";
import { RuntimePanel } from "../components/RuntimePanel";
import { SlotStreamsOverview } from "../components/SlotStreamsOverview";
import { ToastStack } from "../components/ToastStack";
import { WavesPanel } from "../components/WavesPanel";
import { WorkflowBoard } from "../components/WorkflowBoard";
import { useI18n } from "../../i18n/I18nContext";

type Props = {
  activeRoute: Route;
  onNavigate: (route: Route) => void;
};

export function DashboardPage({ activeRoute, onNavigate }: Props) {
  const { t } = useI18n();
  const {
    dashboard,
    error,
    notice,
    refreshError,
    loadedAt,
    raw,
    resumeLabel,
    stopLabel,
    agentActivity,
    agentSlotActivities,
    agentActivityStatus,
    agentActivityError,
    loopControls,
    loopRunState,
    pendingActions,
    toasts,
    dismissToast,
    actions,
  } = useDashboardController();
  const [proposalRefreshToken, setProposalRefreshToken] = useState(0);
  // Token'as turi VIENĄ skaitytoją — `PolicyProposalsPanel`, montuojamą tik `#/reviews` šakoje
  // (žr. žemiau). Kituose maršrutuose panelės DOM'e nėra, tad didinimas būtų state pakeitimas be
  // skaitytojo: re-renderis, kurio niekas nepamato. Praleisti jo negalima tik ten, kur panelė jau
  // stovi ekrane — įeinant į `#/reviews` ji kraunasi pati per mount `useEffect`.
  // Jei prireiktų atnaujinti ją ir iš kito maršruto, ta sąlyga keičiama KARTU su montavimo vieta.
  const refreshAll = () => {
    if (activeRoute === "reviews") {
      setProposalRefreshToken((value) => value + 1);
    }
    void actions.reload();
  };

  // Bangų duomenys imami VIENĄ kartą ir tik ten, kur jie matomi: `#/` srautų santraukai ir
  // `#/system` panelėms. Anksčiau juos siurbė pati `WavesPanel`, tad du vartotojai reikštų du
  // 30 s pollingo srautus tam pačiam endpoint'ui.
  const wavesEnabled = activeRoute === "overview" || activeRoute === "system";
  const { data: waves, error: wavesError, reload: reloadWaves } = useWavesController({ enabled: wavesEnabled });

  const loopControl = dashboard?.loopControl ?? null;
  // `Date.now()` gyvena ČIA, o ne modelyje: gryna funkcija su savo laikrodžiu būtų netestuojama.
  const slotProgress = useMemo(
    () => loopControl === null
      ? []
      // `budgets`/`etas` sąmoningai neperduodami: tokio endpoint'o dar nėra, ir prasimanyta juosta
      // meluotų labiau nei sąžiningas „duomenų nėra".
      : buildSlotProgressViews({
          now: Date.now(),
          loopControl,
          waveSlots: waves?.slots,
          refillDecisions: waves?.refill_decisions,
          activity: agentActivity,
          slotActivities: agentSlotActivities,
          activityStatus: agentActivityStatus,
        }),
    [loopControl, waves, agentActivity, agentSlotActivities, agentActivityStatus],
  );

  // `Set` per `useMemo`: naujas rinkinys kiekvienam renderiui panaikintų `memo` naudą visoje
  // srautų kortelių šakoje.
  const fixable = useMemo(() => fixableTaskIds(dashboard?.humanReview ?? []), [dashboard?.humanReview]);

  // Kurio srauto grandinė rodoma. Dvi užduotys tuo pačiu vardu reiškia, kad priskirti NEĮMANOMA.
  // Nutrūkęs gyvas srautas priskyrimą irgi panaikina: kortelės tada rodo „srautas nežinomas", ir
  // grandinės panelė negali tuo pačiu metu tvirtinti, kad veikla priklauso konkrečiam srautui.
  const correlated = correlateActivity(agentActivity, loopControl?.slots ?? []);
  const chainOwner = agentActivityStatus === "disconnected"
    ? ({ attachedTo: null, attribution: "unknown" } as const)
    : correlated;
  const chainStream = slotProgress.find((view) => view.workerId === chainOwner.attachedTo);

  if (error) {
    return (
      <>
        <Header root="" onRefresh={() => void actions.reload()} activeRoute={activeRoute} onNavigate={onNavigate} />
        <main>
          <div className="panel" style={{ color: "var(--error)" }} role="alert">
            <strong>{t("Error")}:</strong> {error}
            <br />
            <button
              className="button ghost small-button"
              style={{ marginTop: "1rem" }}
              type="button"
              onClick={() => void actions.reload()}
            >
              {t("Try again")}
            </button>
          </div>
        </main>
      </>
    );
  }

  if (!dashboard) {
    return (
      <>
        <Header root="" onRefresh={() => void actions.reload()} activeRoute={activeRoute} onNavigate={onNavigate} />
        <main>
          <div className="panel" style={{ color: "var(--muted)" }}>{t("Loading...")}</div>
        </main>
      </>
    );
  }

  return (
    <>
      <Header
        root={dashboard.root}
        onRefresh={refreshAll}
        activeRoute={activeRoute}
        onNavigate={onNavigate}
        onResumeLoop={() => void actions.resumeLoop()}
        resumeLoopLabel={resumeLabel}
        onStopLoop={() => void actions.stopLoop()}
        stopLoopLabel={stopLabel}
        canResumeLoop={loopControls.canResume}
        canStopLoop={loopControls.canStop}
      />
      <main>
        <div className="page-heading">
          <div>
            <p className="page-eyebrow">{t(pageMeta(activeRoute).eyebrow)}</p>
            <h2>{t(pageMeta(activeRoute).title)}</h2>
            <p>{t(pageMeta(activeRoute).description)}</p>
          </div>
          {/* Ženklelis privalo UŽSITARNAUTI žodį „gyvi": besąlygiškas literalas čia tvirtindavo
              šviežumą net nutrūkus srautui, ir tame pačiame ekrane prieštaraudavo apžvalgos
              metrikai „Pasenusi užduoties būsena" (operatoriaus radinys, 2026-08-24). */}
          <div className="page-heading-signals">
            <FreshnessIndicator refreshFailed={refreshError !== null} loadedAt={loadedAt} now={Date.now()} />
            <StreamIndicator status={agentActivityStatus} />
          </div>
        </div>
        {notice && (
          <div className="notice notice-warning" role="status">
            {notice}
          </div>
        )}
        {refreshError && (
          <div className="notice notice-warning" role="status">
            {t("Refresh failed")}: {refreshError}
          </div>
        )}
        {/* Veiksmų rezultatai rodomi VISUOSE route'uose: mutacija gali būti paleista iš `#/system`, o
            atsakymas neturi dingti vien todėl, kad operatorius tuo metu perėjo į kitą skirtuką. */}
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
        {/* Serveris ĮVARDIJA šaltinį, kurio neperskaitė, ir būtent vardas yra visa šio bloko
            prasmė: be jo trūkstamos panelės atrodo kaip „nieko nelaukia", o ne kaip gedimas. */}
        {dashboard.degraded.length > 0 && (
          <div className="notice notice-warning" role="status">
            ⚠ {t("Some dashboard sources could not be read")}: {dashboard.degraded.join(", ")}
          </div>
        )}
        {agentActivityStatus === "disconnected" && (
          <div className="notice notice-warning" role="status">
            {t("Live activity stream disconnected — the agent chain below may be stale.")}
            {agentActivityError ? ` (${agentActivityError})` : ""}
          </div>
        )}
        {activeRoute === "overview" && (
          <>
            {/* VISOS metrikos. Iki 2026-08-24 čia stovėjo `.slice(0, 4)`, tad „Latest activity" ir
                „Stable commit" buvo skaičiuojamos serveryje, siunčiamos laidu ir NIEKADA nerodomos
                — o `stableRef` yra vienintelė nuoroda, nuo kurio commit'o atkuriamas medis. */}
            <OverviewPanel metrics={dashboard.overview} />
            <div className="command-grid">
              {agentActivity && (
                <AgentChainProgress
                  activity={agentActivity}
                  streamLabel={chainStream ? `${t("Stream")} ${chainStream.index}` : null}
                  attribution={slotProgress.length > 0 ? chainOwner.attribution : undefined}
                />
              )}
              {/* Srautų santrauka be mygtukų: valdymas turi vieną šeimininką `#/system`. */}
              {/* `wavesError` irgi baigia laukimą: nepasiekiamas endpoint'as reiškia, kad daugiau
                  duomenų nebus, ir amžinas skeleton'as tik slėptų tai, kas jau žinoma. */}
              <SlotStreamsOverview
                views={slotProgress}
                awaitingData={!dashboard.loopControl.known && waves === null && wavesError === null}
              />
              <AttentionPanel buckets={dashboard.buckets} />
            </div>
            <QueueSnapshot buckets={dashboard.buckets} onNavigate={() => onNavigate("tasks")} />
          </>
        )}
        {activeRoute === "tasks" && (
          <WorkflowBoard
            buckets={dashboard.buckets}
            onOpenFolder={(bucket) => { void actions.openFolder(bucket); }}
            onUpload={actions.uploadTaskFiles}
            onLoadTasks={actions.loadWorkflowTasks}
          />
        )}
        {activeRoute === "reviews" && (
          <div className="content-stack">
            <ReviewSummary buckets={dashboard.buckets} />
            <HumanReviewPanel />
            {dashboard.policyControls && dashboard.policyControls.length > 0 && (
              <PolicyControlsPanel groups={dashboard.policyControls} onPropose={actions.proposePolicy} />
            )}
            <PolicyProposalsPanel refreshToken={proposalRefreshToken} />
          </div>
        )}
        {/* `learning` nėra, kai serveris neatidavė control-plane bloko. Be šios šakos maršrutas
            rodydavo TIK antraštę ir tuščią lapą — tas pats tylus gedimas, kurį uždarė
            2026-08-23 auditas, tik vieno ekrano dydžio. */}
        {activeRoute === "learning" &&
          (dashboard.learning ? (
            <LearningPanel
              summary={dashboard.learning.summary}
              recommendations={dashboard.learning.recommendations}
              onApprove={actions.approveLearning}
              onReject={actions.rejectLearning}
            />
          ) : (
            <div className="panel" role="status">
              <strong>{t("Learning data is unavailable")}</strong>
              <p className="panel-subtitle">
                {t("The server could not read the control-plane block. Check the notice above and the UI server log.")}
              </p>
              <button className="button ghost small-button" type="button" onClick={() => void actions.reload()}>
                {t("Try again")}
              </button>
            </div>
          ))}
        {activeRoute === "system" && (
          <RuntimePanel
            processes={dashboard.runtime}
            root={dashboard.root}
            // `#/system` paleidimas eina per `/api/runtime/loop/start` (jis atstato ir srautų
            // valdiklį), o Header'io „Paleisti" — per `/tasks/resume`. Suvienodinamas TIK šis ekranas.
            onStartLoop={(workers) => void actions.startLoopWithWorkers(workers)}
            onRefresh={() => void actions.reload()}
            // Vienas ciklo būsenos šaltinis visam `#/system` ekranui: iš jo panelė skaičiuoja ir
            // signalo kortelės, ir ciklo valdymo juostos mygtukus.
            loopRunState={loopRunState}
            workerControl={dashboard.workerControl}
            onSetWorkers={(requested) => void actions.setRequestedWorkers(requested)}
            loopControl={dashboard.loopControl}
            onStopSlot={(workerId) => void actions.stopSlot(workerId)}
            onResumeSlot={(workerId) => void actions.resumeSlot(workerId)}
            onAbortSlot={(workerId) => void actions.abortSlot(workerId)}
            onStopLoop={() => void actions.stopLoop()}
            onRestartLoop={(workers) => void actions.restartLoop(workers)}
            slotProgress={slotProgress}
            pendingActions={pendingActions}
            fixableTaskIds={fixable}
            onFixTask={(taskId) => void actions.fixSlotTask(taskId)}
          />
        )}
        {/* Biudžetas ir diagnostika gyvena `#/system`, nes abu atsako į klausimą „kodėl sistema
            elgiasi taip, kaip elgiasi". Iki 2026-08-24 abiejų duomenys buvo siunčiami ir numetami. */}
        {activeRoute === "system" && raw && <TokenBudgetPanel budget={raw.controlPlane?.token_budget} />}
        {activeRoute === "system" && (
          <WavesPanel data={waves} error={wavesError} onReload={() => void reloadWaves()} />
        )}
        {activeRoute === "system" && raw && <DiagnosticsPanel data={raw} />}
      </main>
    </>
  );
}

function pageMeta(route: Route) {
  const pages = {
    overview: { eyebrow: "Command center", title: "System overview", description: "Critical attention, active work, outcomes, and efficiency—in that order." },
    tasks: { eyebrow: "Workflow", title: "Tasks", description: "Track work from queue to completion without losing operational context." },
    reviews: { eyebrow: "Decision inbox", title: "Reviews", description: "Human decisions and policy changes that cannot be resolved automatically." },
    learning: { eyebrow: "Continuous improvement", title: "Learning", description: "Review evidence-backed recommendations before they affect the workflow." },
    system: { eyebrow: "Administration", title: "System", description: "Runtime health and process availability." },
    analytics: { eyebrow: "Analytics", title: "Analytics", description: "" },
    optimization: { eyebrow: "Optimization", title: "Optimization", description: "" },
    reliability: { eyebrow: "Engineering intelligence", title: "Reliability", description: "File activity, failures, repairs, unresolved work, and deterministic token cost in one view." },
    benchmark: { eyebrow: "Engineering intelligence", title: "Benchmark", description: "Authoritative benchmark verdict, reliability, and baseline comparison for VERQESTRA." },
    compression: { eyebrow: "Engineering intelligence", title: "Compression", description: "Context compression flags and the shadow measurements behind them." },
  };
  return pages[route];
}

function AttentionPanel({ buckets }: { buckets: Array<{ name: string; totalTasks: number }> }) {
  const { t } = useI18n();
  const human = buckets.find((bucket) => bucket.name === "human-review")?.totalTasks ?? 0;
  const failed = buckets.find((bucket) => bucket.name === "failed")?.totalTasks ?? 0;
  const errors = buckets.find((bucket) => bucket.name === "error")?.totalTasks ?? 0;
  const total = human + failed + errors;
  return (
    <section className="panel attention-panel">
      <div className="panel-header">
        <div><h2>{t("Needs attention")}</h2><p className="panel-subtitle">{t("Blocking signals and decisions requiring a human")}</p></div>
        <span className={`badge ${total ? "status-warning" : "status-good"}`}>{total}</span>
      </div>
      <div className="attention-list">
        <div><span>{t("Human review")}</span><strong>{human}</strong></div>
        <div><span>{t("Recovering errors")}</span><strong>{errors}</strong></div>
        <div><span>{t("Failed tasks")}</span><strong>{failed}</strong></div>
      </div>
    </section>
  );
}

function QueueSnapshot({ buckets, onNavigate }: { buckets: Array<{ name: string; totalTasks: number }>; onNavigate: () => void }) {
  const { t } = useI18n();
  const visible = buckets.filter((bucket) => bucket.name !== "done");
  return (
    <section className="panel">
      <div className="panel-header">
        <div><h2>{t("Workflow snapshot")}</h2><p className="panel-subtitle">{t("Distribution of active work")}</p></div>
        <button className="button ghost small-button" type="button" onClick={onNavigate}>{t("Open tasks")} →</button>
      </div>
      <div className="queue-snapshot">
        {visible.map((bucket) => <div key={bucket.name}><span>{bucket.name}</span><strong>{bucket.totalTasks}</strong></div>)}
      </div>
    </section>
  );
}

function ReviewSummary({ buckets }: { buckets: Array<{ name: string; totalTasks: number }> }) {
  const { t } = useI18n();
  const human = buckets.find((bucket) => bucket.name === "human-review")?.totalTasks ?? 0;
  // Nulinė būsena sakoma VIENĄ kartą (2026-08-24, operatoriaus radinys: „nulinės būsenos
  // kartojamos"). Tuščiame `#/reviews` operatorius matydavo tris tą patį sakančius blokus:
  // šį sakinį, `HumanReviewPanel` tuščią būseną ir `PolicyProposalsPanel` inbox-zero. Šis
  // sakinys traukiasi, nes jis neša MAŽIAUSIAI: panelė žemiau tą patį pasako su kontekstu ir
  // veiksmais. Skaičius lieka — jis yra maršruto antraštė, ne pakartojimas.
  return (
    <section className="review-hero">
      <div>
        <span>{t("Open decisions")}</span>
        <strong>{human}</strong>
      </div>
      {human > 0 && <p>{t("Review tasks that automation cannot complete without a human decision.")}</p>}
    </section>
  );
}
