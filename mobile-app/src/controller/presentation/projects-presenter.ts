import type {
  ProjectAgLoopUiState,
  ProjectsReadFailureCode,
  ProjectSummary,
} from "../../model/projects-read.js";
import type { ReadChannelLinkState } from "../../model/read-channel.js";
import type { AppState } from "../../model/state.js";
import type {
  ProjectRepositoryViewState,
  ProjectRow,
  ProjectsChannelViewState,
  ProjectsViewState,
} from "../../view/projects-view-state.js";

/**
 * Presentation for the read-only Projects space.
 *
 * The screen shows which projects the host registered, what each of them is
 * bound to, and how far the selected project's checked-out branch has drifted.
 * Every wording decision — an empty registry, a project with no repository, a
 * binding the last read could not confirm — is taken here, so the screen cannot
 * turn a missing answer into a reassuring one.
 *
 * The view state carries no create, bind, checkout or pull affordance, because
 * the space has none: selecting a project is the only intent, and it changes
 * nothing on the host.
 */

const linkLabels: Readonly<Record<ReadChannelLinkState, string>> = Object.freeze({
  connecting: "Connecting",
  connected: "Connected",
  degraded: "Reconnecting — last known state",
  offline: "Offline",
});

const failureMessages: Readonly<Record<ProjectsReadFailureCode, string>> = Object.freeze({
  unavailable: "The project registry is not reachable.",
  unauthorized: "Device pairing is required.",
  not_found: "This project is no longer visible to this device.",
  repository_not_bound: "No repository is bound to this project.",
  invalid_response: "The project response was rejected.",
  transport_failed: "The project read failed.",
});

const agLoopUiLabels: Readonly<Record<ProjectAgLoopUiState, string>> = Object.freeze({
  online: "AG Loop UI online",
  offline: "AG Loop UI offline",
  not_configured: "AG Loop UI not configured",
});

function isReading(state: AppState): boolean {
  return state.projectsReadsInFlight > 0;
}

function presentChannel(state: AppState): ProjectsChannelViewState {
  // Nothing has ever been attempted or answered, so an offline badge would blame
  // the network for a channel that was simply never wired up.
  const unconfigured = state.projects === null &&
    state.projectsError === null &&
    !isReading(state) &&
    state.projectsLink !== "connecting";
  return Object.freeze({
    link: state.projectsLink,
    label: unconfigured ? "Not configured" : linkLabels[state.projectsLink],
    refreshing: isReading(state),
    stale: state.projects !== null && state.projectsError !== null,
    errorMessage: state.projectsError === null ? null : failureMessages[state.projectsError],
    canRetry: !unconfigured && !isReading(state),
  });
}

function projectRows(state: AppState): readonly ProjectRow[] {
  return Object.freeze((state.projects ?? []).map((project: ProjectSummary) => Object.freeze({
    key: project.projectId,
    projectId: project.projectId,
    name: project.name,
    // A project the host registered without a repository name says so, rather
    // than rendering an empty cell that reads as a missing label.
    repositoryLabel: project.repository.length === 0 ? "No repository bound" : project.repository,
    branchLabel: project.branch.length === 0 ? "No branch reported" : project.branch,
    agLoopUi: project.agLoopUi,
    agLoopUiLabel: agLoopUiLabels[project.agLoopUi],
    selected: project.projectId === state.selectedProjectId,
  })));
}

function divergenceLabel(ahead: number, behind: number): string {
  if (ahead === 0 && behind === 0) return "In sync with the remote";
  return `${ahead} ahead · ${behind} behind`;
}

function presentRepository(state: AppState): ProjectRepositoryViewState {
  const status = state.projectRepository;
  const failure = state.projectRepositoryError;
  const noSelection = state.selectedProjectId === null;
  return Object.freeze({
    available: status !== null,
    noSelection,
    repositoryLabel: status?.repository ?? null,
    branchLabel: status?.branch ?? null,
    dirtyLabel: status === null
      ? null
      : status.dirty
        ? "Uncommitted changes in the host checkout"
        : "Working tree clean",
    divergenceLabel: status === null ? null : divergenceLabel(status.ahead, status.behind),
    // A binding still on screen that the last read did not confirm is stale, the
    // same rule the channel badge uses for the list.
    stale: status !== null && failure !== null,
    errorMessage: failure === null ? null : failureMessages[failure],
    unavailableLabel: noSelection
      ? "Select a project to see its repository state."
      : "No repository state has been received for this project.",
  });
}

export function presentProjects(state: AppState): ProjectsViewState {
  const rows = projectRows(state);
  // The registry link, not any read in flight: a repository read shares the
  // channel's counter but says nothing about the listing, and must not put
  // "reading the registered projects" on a screen where nothing is.
  const showLoadingPlaceholder = state.projects === null &&
    state.projectsLink === "connecting";
  return Object.freeze({
    title: "Projects — read-only",
    readOnly: true,
    connection: presentChannel(state),
    showLoadingPlaceholder,
    showUnavailablePlaceholder: state.projects === null && !showLoadingPlaceholder,
    unavailableLabel: "No project list has been received yet.",
    isEmpty: state.projects !== null && rows.length === 0,
    emptyLabel: "No project is registered on the host.",
    rows,
    totalCount: state.projectsTotalCount,
    // The host's own total outranks the carried list, so a capped list never
    // reads as the whole registry.
    hiddenCount: Math.max(0, state.projectsTotalCount - rows.length),
    selectedProjectId: state.selectedProjectId,
    repository: presentRepository(state),
  });
}
