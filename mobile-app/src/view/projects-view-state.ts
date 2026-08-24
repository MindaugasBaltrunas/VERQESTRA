import type { ProjectAgLoopUiState } from "../model/projects-read.js";
import type { ReadChannelLinkState } from "../model/read-channel.js";

/**
 * View state of the read-only Projects space. Types only — the projection that
 * fills them is `controller/presentation/projects-presenter.ts`; see
 * `ag-loop-view-state.ts` for why the two are separate files here.
 */

/** Re-exported so a screen never has to name the Model to describe itself. */
export type { ProjectAgLoopUiState } from "../model/projects-read.js";

export type ProjectsChannelViewState = Readonly<{
  link: ReadChannelLinkState;
  label: string;
  refreshing: boolean;
  /** The shown list is cached and no longer confirmed by the host. */
  stale: boolean;
  errorMessage: string | null;
  canRetry: boolean;
}>;

export type ProjectRow = Readonly<{
  key: string;
  projectId: string;
  name: string;
  /** Logical repository name; never an absolute host path. */
  repositoryLabel: string;
  branchLabel: string;
  agLoopUi: ProjectAgLoopUiState;
  agLoopUiLabel: string;
  selected: boolean;
}>;

export type ProjectRepositoryViewState = Readonly<{
  /** A repository state is on screen for the selected project. */
  available: boolean;
  /** No project is selected, so there is nothing to bind a repository to. */
  noSelection: boolean;
  repositoryLabel: string | null;
  branchLabel: string | null;
  /** Uncommitted work in the host checkout; `null` until a state was read. */
  dirtyLabel: string | null;
  /** Divergence from the remote, worded even when it is zero in both directions. */
  divergenceLabel: string | null;
  /** The shown binding was not confirmed by the last read. */
  stale: boolean;
  errorMessage: string | null;
  /** What the pane says when it has no repository state at all. */
  unavailableLabel: string;
}>;

export type ProjectsViewState = Readonly<{
  title: string;
  /** Structural, not a flag: this space exposes no project mutation. */
  readOnly: true;
  connection: ProjectsChannelViewState;
  showLoadingPlaceholder: boolean;
  /** No list was received and none is being read: offline or never configured. */
  showUnavailablePlaceholder: boolean;
  unavailableLabel: string;
  /** The host answered, and its registry is empty. */
  isEmpty: boolean;
  emptyLabel: string;
  rows: readonly ProjectRow[];
  /** Distinct projects the host named; outranks the shown rows. */
  totalCount: number;
  /** Projects the defensive cap removed; the total stays authoritative. */
  hiddenCount: number;
  selectedProjectId: string | null;
  repository: ProjectRepositoryViewState;
}>;
