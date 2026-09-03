import { useMemo, useState } from "react";
import { PolicyProposalsPanel } from "../components/dashboard/PolicyProposalsPanel";
import { LOOP_RESUME_ACTION, useDashboardController } from "../../controller/useDashboardController";
import { useWavesController } from "../../controller/useWavesController";
import { selectInFlightSlots, type InFlightSlot } from "../../model/dashboardViewModel";
import { fixableTaskIds } from "../../model/loopControlsViewModel";
import { buildSlotProgressViews, correlateActivity } from "../../model/slotProgressViewModel";
import { AgentChainProgress } from "../components/dashboard/AgentChainProgress";
import { DiagnosticsPanel } from "../components/dashboard/DiagnosticsPanel";
import { FreshnessIndicator, StreamIndicator } from "../components/shared/FreshnessIndicator";
import { TokenBudgetPanel } from "../components/tokens/TokenBudgetPanel";
import { Header, type Route } from "../components/layout/Header";
import { HumanReviewPanel } from "../components/dashboard/HumanReviewPanel";
import { LearningPanel } from "../components/dashboard/LearningPanel";
import { OverviewPanel } from "../components/dashboard/OverviewPanel";
import { PolicyControlsPanel } from "../components/dashboard/PolicyControlsPanel";
import { RuntimePanel } from "../components/dashboard/RuntimePanel";
import { SlotStreamsOverview } from "../components/dashboard/SlotStreamsOverview";
import { SystemStatusHero } from "../components/dashboard/SystemStatusHero";
import { ToastStack } from "../components/shared/ToastStack";
import { WavesPanel } from "../components/dashboard/WavesPanel";
import { WorkflowBoard } from "../components/dashboard/WorkflowBoard";
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
  // in-flight eilutei, `#/tasks` lentos „vykdoma" ženkleliams, `#/system` panelėms. Anksčiau
  // juos siurbė pati `WavesPanel`, tad du vartotojai reikštų du 30 s pollingo srautus tam
  // pačiam endpoint'ui. Trečias vartotojas (`tasks`) nieko nekainuoja: valdiklis vienas, ir
  // maršrutų sąlyga lieka VIENOJE vietoje — dubliuoti ją komponentuose reikštų du srautus.
  const wavesEnabled = activeRoute === "overview" || activeRoute === "system" || activeRoute === "tasks";
  const { data: waves, error: wavesError, reload: reloadWaves } = useWavesController({ enabled: wavesEnabled });

  // Kas DABAR sukasi w1/w2 — gryna `/api/waves` projekcija. Pagrindinio medžio bucket'ai to
  // nemato: worktree slot'o vaikas `queue→active` perkėlimą daro SAVO kopijoje, tad suvestinės
  // `active` čia amžinai 0 (2026-09-02 apžvalgos auditas). `null` duomenys ir bangų klaida
  // duoda TUŠČIĄ sąrašą, o tuščias sąrašas nerodo nieko: „0 vykdoma" tvirtintų, kad nieko
  // nevyksta, nors iš tiesų tiesiog nežinoma.
  const inFlight = useMemo(() => selectInFlightSlots(waves), [waves]);

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
  // „Šiuo metu vykdoma" imama iš GYVŲ srautų, ne iš `current-task-id` žymės: žymę rašo tik
  // pirminio medžio dispatch'as, tad worktree bangų metu ji rodė vakarykštį task'ą
  // (2026-09-02 apžvalgos auditas). Be gyvų srautų — `null`, t. y. „tarp užduočių".
  const executingLabel = slotProgress
    .filter((view) => view.taskId !== null)
    .map((view) => `${view.taskId}`)
    .join(" · ") || null;

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
            <h1>{t(pageMeta(activeRoute).title)}</h1>
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
            {/* Valdymo centras pirmiausia atsako „kas vyksta DABAR ir ko reikia iš manęs" — tas pats
                hero kaip `#/system`, tie patys šaltiniai. Iki 2026-09-02 jis gyveno tik `#/system`,
                o apžvalga prasidėdavo pasenusiais pirminio medžio signalais. */}
            <SystemStatusHero
              loopRunState={loopRunState}
              currentTaskId={executingLabel}
              queueCount={dashboard.buckets.find((bucket) => bucket.name === "queue")?.totalTasks ?? 0}
              humanReviewCount={dashboard.buckets.find((bucket) => bucket.name === "human-review")?.totalTasks ?? 0}
              canStartLoop={loopControls.canResume}
              startLoopBusy={pendingActions.has(LOOP_RESUME_ACTION)}
              onStartLoop={() => void actions.resumeLoop()}
              onGoToReviews={() => onNavigate("reviews")}
            />
            {/* VISOS metrikos. Iki 2026-08-24 čia stovėjo `.slice(0, 4)`, tad „Latest activity" ir
                „Stable commit" buvo skaičiuojamos serveryje, siunčiamos laidu ir NIEKADA nerodomos
                — o `stableRef` yra vienintelė nuoroda, nuo kurio commit'o atkuriamas medis. */}
            <OverviewPanel metrics={dashboard.overview} slotProgress={slotProgress} workerControl={dashboard.workerControl} />
            <div className="command-grid">
              {agentActivity && (
                <AgentChainProgress
                  activity={agentActivity}
                  streamLabel={chainStream ? `${t("Stream")} ${chainStream.index}` : null}
                  attribution={slotProgress.length > 0 ? chainOwner.attribution : undefined}
                  // Per-srautinės grandinės (`/api/events` `slots[]`): iki 2026-09-02 jos buvo
                  // skaitomos, bet čia NEPERDUODAMOS, tad panelė rodė tik globalų veidrodį.
                  slots={agentActivityStatus === "disconnected" ? [] : [...agentSlotActivities]}
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
            <QueueSnapshot buckets={dashboard.buckets} inFlight={inFlight} onNavigate={() => onNavigate("tasks")} />
          </>
        )}
        {activeRoute === "tasks" && (
          <WorkflowBoard
            buckets={dashboard.buckets}
            // Gyvi srautai iš valdiklio: worktree slot'o task'as pagrindiniame medyje tebeguli
            // `queue`, tad be šio sąrašo lenta jį rodytų kaip laukiantį (2026-09-02 auditas).
            liveSlots={slotProgress.flatMap((view) =>
              view.taskId === null ? [] : [{ workerId: view.workerId, index: view.index, taskId: view.taskId }],
            )}
            // Bangų worker→task žemėlapis: jis vardija DARBININKĄ, o `slotProgress` — srauto
            // numerį. Ta pati eilutė, tikslesnis šaltinis: `/api/waves` mato ir tą slot'ą,
            // kurio ciklo valdymo blokas dar nespėjo parodyti.
            inFlight={inFlight}
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
        {/* Vienintelis atsakymas į „kas vyksta DABAR ir ko reikia iš manęs" — VIRŠUJE, prieš
            visas kitas `#/system` panelias. Duomenys: `dashboard.buckets` (eilė, žmogaus peržiūra),
            `raw.currentTaskId` (vykdoma užduotis) ir tas pats `loopControls.canResume`/`LOOP_RESUME_ACTION`
            šaltinis, kuriuo remiasi Header'io „Paleisti" mygtukas — antra kopija čia meluotų taip
            pat, kaip meluodavo 048 audito radinys. */}
        {activeRoute === "system" && (
          <SystemStatusHero
            loopRunState={loopRunState}
            currentTaskId={executingLabel}
            queueCount={dashboard.buckets.find((bucket) => bucket.name === "queue")?.totalTasks ?? 0}
            humanReviewCount={dashboard.buckets.find((bucket) => bucket.name === "human-review")?.totalTasks ?? 0}
            canStartLoop={loopControls.canResume}
            startLoopBusy={pendingActions.has(LOOP_RESUME_ACTION)}
            onStartLoop={() => void actions.resumeLoop()}
            onGoToReviews={() => onNavigate("reviews")}
          />
        )}
        {/* Hero jau atsakė „kas vyksta DABAR ir ko reikia iš manęs" — likę mechanizmai (procesai,
            biudžetas, bangos, diagnostika) yra PAAIŠKINIMAS, ne veiksmas, tad slepiami po
            <details>/<summary> pagal nutylėjimą. Nė vienas duomuo nedingsta iš DOM — tik
            perkeliamas žemiau hero ir uždaromas. */}
        {activeRoute === "system" && (
          <details className="system-panel-details">
            <summary><span>{t("Runtime")}</span></summary>
            <div className="system-panel-details-body">
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
            </div>
          </details>
        )}
        {/* Biudžetas ir diagnostika gyvena `#/system`, nes abu atsako į klausimą „kodėl sistema
            elgiasi taip, kaip elgiasi". Iki 2026-08-24 abiejų duomenys buvo siunčiami ir numetami. */}
        {activeRoute === "system" && raw && (
          <details className="system-panel-details">
            <summary><span>{t("Token budget")}</span></summary>
            <div className="system-panel-details-body">
              <TokenBudgetPanel budget={raw.controlPlane?.token_budget} />
            </div>
          </details>
        )}
        {activeRoute === "system" && (
          <details className="system-panel-details">
            <summary><span>{t("Waves")}</span></summary>
            <div className="system-panel-details-body">
              <WavesPanel data={waves} error={wavesError} onReload={() => void reloadWaves()} />
            </div>
          </details>
        )}
        {activeRoute === "system" && raw && (
          <details className="system-panel-details">
            <summary><span>{t("Diagnostics")}</span></summary>
            <div className="system-panel-details-body">
              <DiagnosticsPanel data={raw} />
            </div>
          </details>
        )}
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

function QueueSnapshot({
  buckets,
  inFlight,
  onNavigate,
}: {
  buckets: Array<{ name: string; totalTasks: number }>;
  /** Worker→task poros iš bangų; tuščia reiškia „nežinoma", ne „nieko nevyksta" — tada eilutės nėra. */
  inFlight: readonly InFlightSlot[];
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  const visible = buckets.filter((bucket) => bucket.name !== "done");
  // Bucket'ų skaičiai atsako, KIEK darbo laukia; ši eilutė — KAS iš jo jau sukasi. Be jos
  // worktree bangos metu suvestinė rodė vien nulius, nes slot'ų perėjimai vyksta kopijose.
  const pairs = inFlight.map((slot) => `${slot.workerId} → ${slot.taskId}`).join(", ");
  return (
    <section className="panel">
      <div className="panel-header">
        <div><h2>{t("Workflow snapshot")}</h2><p className="panel-subtitle">{t("Distribution of active work")}</p></div>
        {/* Tas pats ženklas kaip Užduočių lentoje: operatorius jį jau moka skaityti, ir naujos
            klasės čia reikštų naują išvaizdą tam pačiam faktui. PILNAS sąrašas lieka `title`. */}
        {inFlight.length > 0 && (
          <div className="running-now" role="status" title={pairs}>
            <span className="agent-step-pulse" />
            <span className="running-now-label">{t("Running in worktree streams")}:</span>
            <strong>{pairs}</strong>
          </div>
        )}
        <button className="button ghost small-button" type="button" onClick={onNavigate}>{t("Open tasks")} →</button>
      </div>
      <div className="queue-snapshot">
        {/* Bucket'o vardas verčiamas: LT režime čia likdavo `queue`/`human-review` (2026-09-02 auditas). */}
        {visible.map((bucket) => <div key={bucket.name}><span>{t(bucket.name)}</span><strong>{bucket.totalTasks}</strong></div>)}
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
