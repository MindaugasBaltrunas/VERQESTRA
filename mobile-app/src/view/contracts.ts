import type {
  AgLoopTaskBucket,
  DashboardViewState,
  TasksViewState,
} from "./ag-loop-view-state.js";
import type { ConnectionsViewState } from "./connections-view-state.js";
import type { ProjectsViewState } from "./projects-view-state.js";
import type { SessionReviewViewState } from "./session-review-view-state.js";
import type { Provider, TerminalViewState } from "./terminal-view-state.js";

/**
 * NUKRYPIMAS (importų kryptis, ne turinys): etalone šie propsai importavo savo `*ViewState`
 * tipus iš `adapters/presentation/*-presenter.js`, tad ekrano tipas priklausė nuo projekcijos
 * MODULIO. VERQESTRA'oje tipai gyvena `view/*-view-state.ts`, o presenteriai juos importuoja —
 * rodyklė apversta. Rezultatas praktinis: `view/` neturi nė vieno kelio į `controller/`, tad
 * ekranas negali pasiekti projekcijos funkcijos vien dėl to, kad jam prireikė jos tipo.
 */

/**
 * Mobile-controlled Agent Terminal. The intents are exactly the ones the
 * presenter can enable: provider choice, composer editing, the four PTY
 * lifecycle actions and push-to-talk.
 *
 * Voice is deliberately split into holding the button, editing or acknowledging
 * what came back, and confirming it. There is no "dictate and send" intent: the
 * View cannot express one, so no screen can hand the host a command the operator
 * has not read.
 */
export type TerminalViewProps = Readonly<{
  state: TerminalViewState;
  onProviderSelected(provider: Provider): void;
  onComposerChanged(text: string): void;
  onStartPressed(): void;
  onSubmitPressed(): void;
  onInterruptPressed(): void;
  onClosePressed(): void;
  onDetachPressed(): void;
  onVoiceHoldStart(): void;
  onVoiceHoldEnd(): void;
  onVoiceDraftChanged(text: string): void;
  onVoiceAcknowledged(): void;
  onVoiceCloudConsentChanged(granted: boolean): void;
  onVoiceConfirmed(): void;
  onVoiceCancelled(): void;
}>;

/**
 * Read-only AG Loop screens. The intents are refresh and bucket selection only:
 * there is deliberately no contract through which a view could mutate AG Loop.
 */
export type DashboardViewProps = Readonly<{
  state: DashboardViewState;
  onRefreshPressed(): void;
}>;

export type TasksViewProps = Readonly<{
  state: TasksViewState;
  onRefreshPressed(): void;
  onBucketSelected(bucket: AgLoopTaskBucket): void;
}>;

/**
 * Read-only session review. Refresh is the only intent: there is deliberately
 * no contract through which a view could merge, retry, edit or otherwise act on
 * the reviewed session.
 */
export type SessionReviewViewProps = Readonly<{
  state: SessionReviewViewState;
  onRefreshPressed(): void;
}>;

/**
 * Read-only host connections. Refresh is the only intent: connecting,
 * disconnecting and authorizing are host-side work, and there is deliberately no
 * contract through which a view could start any of them.
 */
export type ConnectionsViewProps = Readonly<{
  state: ConnectionsViewState;
  onRefreshPressed(): void;
}>;

/**
 * Read-only project directory. Refresh and selection are the only intents:
 * selecting decides which project's repository state is read, and there is
 * deliberately no contract through which a view could create a project, bind a
 * repository or move a branch.
 */
export type ProjectsViewProps = Readonly<{
  state: ProjectsViewState;
  onRefreshPressed(): void;
  onProjectSelected(projectId: string): void;
}>;
