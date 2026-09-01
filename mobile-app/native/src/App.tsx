import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Pressable, StatusBar, StyleSheet, Text, View } from "react-native";

import {
  AgLoopReadController,
  ConnectionsController,
  initialAppState,
  presentConnections,
  presentDashboard,
  presentProjects,
  presentSessionReview,
  presentTasks,
  presentTerminal,
  ProjectsController,
  reduceAppState,
  SessionReviewController,
} from "./core";
import type {
  AgLoopTaskBucket,
  AgLoopUiReadPort,
  HostConnectionsReadPort,
  ProjectsReadPort,
  Provider,
  SessionReviewReadPort,
} from "./core";
import {
  createMobileAppRuntime,
  defaultTerminalGeometry,
  type MobileAppRuntime,
  type MobileTerminalPorts,
} from "./composition/create-app-runtime";
import { ConnectionsScreen } from "./screens/ConnectionsScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { SessionReviewScreen } from "./screens/SessionReviewScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { TerminalScreen } from "./screens/TerminalScreen";

/**
 * Root component of the product spaces.
 *
 * Ports are injected, never constructed here. `composition/native-runtime.ts`
 * is the one place that decides which of them this installation has, and the
 * Expo entry registers this component with exactly what it composed — the
 * configured project and session included.
 *
 * What that composition can hand over today is still less than the props
 * declare: the read-only AG Loop, review, connections and projects ports have
 * no adapter yet, the secure credential store is task 119, the biometric write
 * gate task 120 and speech recognition task 121. Every one of them is absent
 * rather than stubbed, so the screens keep reporting honestly what is not
 * wired instead of inventing data or offering controls that lead nowhere.
 */
export type AppProps = Readonly<{
  agLoopReads?: AgLoopUiReadPort;
  /** Read-only session review port; the Review space says so when it is absent. */
  sessionReviewReads?: SessionReviewReadPort;
  /** Read-only host connections port; the Connections space says so when absent. */
  connectionsReads?: HostConnectionsReadPort;
  /** Read-only project directory port; the Projects space says so when absent. */
  projectsReads?: ProjectsReadPort;
  /** Terminal transport ports; the Agent Terminal space needs all of them. */
  terminal?: MobileTerminalPorts;
  /** Project the spaces open on; the Projects space can move the selection. */
  projectId?: string;
  /** Session to review; falls back to the terminal session this device started. */
  sessionId?: string;
}>;

type Space = "dashboard" | "tasks" | "projects" | "connections" | "review" | "terminal";

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingTop: 48,
  },
  body: {
    flex: 1,
  },
  tabBar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#d0d0d0",
  },
  tab: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 14,
  },
  tabLabel: {
    fontSize: 13,
    color: "#6b6b6b",
  },
  tabLabelSelected: {
    color: "#1f2933",
    fontWeight: "700",
  },
});

export default function App({
  agLoopReads,
  sessionReviewReads,
  connectionsReads,
  projectsReads,
  terminal,
  projectId,
  sessionId,
}: AppProps) {
  const [state, dispatch] = useReducer(reduceAppState, initialAppState);
  const [space, setSpace] = useState<Space>("dashboard");
  const [composerDraft, setComposerDraft] = useState("");

  const agLoopController = useMemo(
    () => (agLoopReads ? new AgLoopReadController(agLoopReads, dispatch) : null),
    [agLoopReads],
  );
  const sessionReviewController = useMemo(
    () => (sessionReviewReads ? new SessionReviewController(sessionReviewReads, dispatch) : null),
    [sessionReviewReads],
  );
  const connectionsController = useMemo(
    () => (connectionsReads ? new ConnectionsController(connectionsReads, dispatch) : null),
    [connectionsReads],
  );
  const projectsController = useMemo(
    () => (projectsReads ? new ProjectsController(projectsReads, dispatch) : null),
    [projectsReads],
  );
  const runtime = useMemo(
    () => (terminal ? createMobileAppRuntime({ ...terminal, dispatch }) : null),
    [terminal],
  );

  // The Agent Terminal space is offered only when its transport is wired: a
  // lifecycle button that cannot reach a host would be a dead control. The
  // Review space is always offered, because it carries no control at all and
  // states plainly when nothing is wired or no session is selected.
  const spaces = useMemo(() => Object.freeze([
    Object.freeze({ id: "dashboard" as const, label: "Dashboard" }),
    Object.freeze({ id: "tasks" as const, label: "Tasks" }),
    Object.freeze({ id: "projects" as const, label: "Projects" }),
    Object.freeze({ id: "connections" as const, label: "Connections" }),
    Object.freeze({ id: "review" as const, label: "Review" }),
    ...(runtime ? [Object.freeze({ id: "terminal" as const, label: "Terminal" })] : []),
  ]), [runtime]);

  const selectedProjectId = state.selectedProjectId;
  const selectedProvider = state.selectedProvider;
  const selectedBucket = state.agLoopSelectedBucket;
  const voiceDraft = state.voiceDraft;

  useEffect(() => {
    if (projectId === undefined) return;
    dispatch({ type: "project.selected", projectId });
  }, [projectId]);

  const refresh = useCallback(() => {
    if (!agLoopController || selectedProjectId === null) return;
    void agLoopController.refresh({ projectId: selectedProjectId, bucket: selectedBucket });
  }, [agLoopController, selectedProjectId, selectedBucket]);

  const selectBucket = useCallback((bucket: AgLoopTaskBucket) => {
    if (!agLoopController || selectedProjectId === null) return;
    void agLoopController.selectBucket({ projectId: selectedProjectId, bucket });
  }, [agLoopController, selectedProjectId]);

  // The read-only channel is loaded once per project. `refresh` changes identity
  // whenever the selected bucket changes, so re-running it on every change would
  // issue a second, redundant dashboard + bucket read for the same tab press —
  // `selectBucket` already reads the bucket the user just picked.
  const loadedProjectId = useRef<string | null>(null);
  useEffect(() => {
    if (!agLoopController || selectedProjectId === null) {
      loadedProjectId.current = null;
      return;
    }
    if (loadedProjectId.current === selectedProjectId) return;
    loadedProjectId.current = selectedProjectId;
    refresh();
  }, [agLoopController, selectedProjectId, refresh]);

  const refreshConnections = useCallback(() => {
    void connectionsController?.refresh();
  }, [connectionsController]);

  // The host connection state is read once per wired controller, for the same
  // reason the AG Loop channel is loaded once per project: it describes the host,
  // not the screen, and re-reading it on every render would start a CLI probe per
  // frame.
  const readConnectionsFor = useRef<ConnectionsController | null>(null);
  useEffect(() => {
    if (!connectionsController) {
      readConnectionsFor.current = null;
      return;
    }
    if (readConnectionsFor.current === connectionsController) return;
    readConnectionsFor.current = connectionsController;
    refreshConnections();
  }, [connectionsController, refreshConnections]);

  const refreshProjects = useCallback(() => {
    void projectsController?.refresh({ projectId: selectedProjectId });
  }, [projectsController, selectedProjectId]);

  // Which project the shell has already read a repository state for. The user's
  // own selection records itself here, so the effect below does not read the same
  // project a second time.
  const openedProjectId = useRef<string | null>(null);

  const selectProject = useCallback((nextProjectId: string) => {
    openedProjectId.current = nextProjectId;
    if (!projectsController) {
      dispatch({ type: "project.selected", projectId: nextProjectId });
      return;
    }
    void projectsController.selectProject({ projectId: nextProjectId });
  }, [projectsController]);

  const listedProjectsFor = useRef<ProjectsController | null>(null);
  useEffect(() => {
    if (!projectsController) {
      listedProjectsFor.current = null;
      return;
    }
    if (listedProjectsFor.current === projectsController) return;
    listedProjectsFor.current = projectsController;
    void projectsController.refresh({ projectId: null });
  }, [projectsController]);

  // A project selected elsewhere — by the `projectId` prop — still needs its
  // repository state. It is refreshed, never re-selected: selecting resets the
  // spaces that follow the project, and the project has not moved.
  useEffect(() => {
    if (!projectsController || selectedProjectId === null) return;
    if (openedProjectId.current === selectedProjectId) return;
    openedProjectId.current = selectedProjectId;
    void projectsController.refreshRepository({ projectId: selectedProjectId });
  }, [projectsController, selectedProjectId]);

  // An explicit session outranks the one this device happens to be running: the
  // reviewed session is what the operator asked for, not what is live here.
  const reviewedSessionId = sessionId ?? runtime?.controller.session?.sessionId ?? null;

  const refreshReview = useCallback(() => {
    if (!sessionReviewController || selectedProjectId === null || reviewedSessionId === null) return;
    void sessionReviewController.refresh({
      projectId: selectedProjectId,
      sessionId: reviewedSessionId,
    });
  }, [sessionReviewController, selectedProjectId, reviewedSessionId]);

  // The review is opened once per session, for the same reason the AG Loop
  // channel is loaded once per project: a re-run on every render would re-read
  // the same session and clear the pane the operator is reading.
  const loadedSessionId = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionReviewController || selectedProjectId === null || reviewedSessionId === null) {
      loadedSessionId.current = null;
      return;
    }
    if (loadedSessionId.current === reviewedSessionId) return;
    loadedSessionId.current = reviewedSessionId;
    void sessionReviewController.open({
      projectId: selectedProjectId,
      sessionId: reviewedSessionId,
    });
  }, [sessionReviewController, selectedProjectId, reviewedSessionId]);

  // Every terminal failure the controller can attribute is already dispatched as
  // a user-facing message, so the shell has nothing to add to the rejection.
  const runTerminalAction = useCallback((action: () => Promise<unknown>) => {
    void action().catch(() => undefined);
  }, []);

  const selectProvider = useCallback((provider: Provider) => {
    dispatch({ type: "provider.selected", provider });
  }, []);

  const startSession = useCallback(() => {
    if (!runtime || selectedProjectId === null || selectedProvider === null) return;
    runTerminalAction(() => runtime.controller.start({
      projectId: selectedProjectId,
      provider: selectedProvider,
      ...defaultTerminalGeometry,
    }));
  }, [runtime, runTerminalAction, selectedProjectId, selectedProvider]);

  const submitDraft = useCallback(() => {
    if (!runtime) return;
    // The draft is cleared only once the gateway accepted it: a rejected command
    // stays in the composer instead of vanishing unsent.
    runTerminalAction(() => runtime.controller.submitKeyboard(composerDraft)
      .then(() => setComposerDraft("")));
  }, [runtime, runTerminalAction, composerDraft]);

  // The transcript is confirmed through the voice controller, never sent
  // straight to the terminal: it is the only place that checks the text on
  // screen is the transcript that was recognised, and it clears the panel
  // itself once the command was accepted.
  const confirmVoiceDraft = useCallback(() => {
    const voice = runtime?.voice;
    if (!voice) return;
    runTerminalAction(() => voice.confirm(voiceDraft));
  }, [runtime, runTerminalAction, voiceDraft]);

  const cancelVoiceDraft = useCallback(() => {
    // Without a voice controller there is no capture to abandon, only a Model
    // transcript to drop.
    if (runtime?.voice) {
      runtime.voice.cancel();
      return;
    }
    dispatch({ type: "voice.cancelled" });
  }, [runtime]);

  const startVoiceHold = useCallback(() => {
    void runtime?.voice?.holdStarted();
  }, [runtime]);

  const endVoiceHold = useCallback(() => {
    void runtime?.voice?.holdEnded();
  }, [runtime]);

  const editVoiceDraft = useCallback((text: string) => {
    runtime?.voice?.edit(text);
  }, [runtime]);

  const acknowledgeVoiceDraft = useCallback(() => {
    runtime?.voice?.acknowledgeLowConfidence();
  }, [runtime]);

  const changeVoiceCloudConsent = useCallback((granted: boolean) => {
    const voice = runtime?.voice;
    if (!voice) return;
    runTerminalAction(() => voice.setCloudConsent(granted));
  }, [runtime, runTerminalAction]);

  // Speech availability is probed once per runtime, for the same reason the AG
  // Loop channel is loaded once per project: repeating it on every render would
  // re-ask the OS for a fact that only changes with the device's settings.
  const probedRuntime = useRef<MobileAppRuntime | null>(null);
  useEffect(() => {
    if (!runtime?.voice) {
      probedRuntime.current = null;
      return;
    }
    if (probedRuntime.current === runtime) return;
    probedRuntime.current = runtime;
    void runtime.voice.refreshAvailability();
  }, [runtime]);

  const interruptSession = useCallback(() => {
    if (!runtime) return;
    runTerminalAction(() => runtime.controller.interrupt());
  }, [runtime, runTerminalAction]);

  // Leaving the terminal takes the pending transcript with it, mirroring the
  // write gate's own lock: a command dictated for a session the operator walked
  // away from must not be sendable when they come back.
  const closeSession = useCallback(() => {
    if (!runtime) return;
    runtime.voice?.cancel();
    runTerminalAction(() => runtime.controller.close());
  }, [runtime, runTerminalAction]);

  const detachStream = useCallback(() => {
    runtime?.voice?.cancel();
    runtime?.controller.detachStream();
  }, [runtime]);

  // Switching space is leaving the terminal as surely as detaching from it: the
  // screen that authorised the microphone unmounts, so its press-out never
  // arrives. Cancelling here is what stops a capture from outliving it.
  const selectSpace = useCallback((next: Space) => {
    if (next !== "terminal") runtime?.voice?.cancel();
    setSpace(next);
  }, [runtime]);

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="default" />
      <View style={styles.body}>
        {space === "terminal" && runtime ? (
          <TerminalScreen
            onClosePressed={closeSession}
            onComposerChanged={setComposerDraft}
            onDetachPressed={detachStream}
            onInterruptPressed={interruptSession}
            onProviderSelected={selectProvider}
            onStartPressed={startSession}
            onSubmitPressed={submitDraft}
            onVoiceAcknowledged={acknowledgeVoiceDraft}
            onVoiceCancelled={cancelVoiceDraft}
            onVoiceCloudConsentChanged={changeVoiceCloudConsent}
            onVoiceConfirmed={confirmVoiceDraft}
            onVoiceDraftChanged={editVoiceDraft}
            onVoiceHoldEnd={endVoiceHold}
            onVoiceHoldStart={startVoiceHold}
            state={presentTerminal(state, {
              composerDraft,
              activeBranch: runtime.controller.session?.branch ?? null,
            })}
          />
        ) : space === "review" ? (
          <SessionReviewScreen
            onRefreshPressed={refreshReview}
            state={presentSessionReview(state)}
          />
        ) : space === "connections" ? (
          <ConnectionsScreen
            onRefreshPressed={refreshConnections}
            state={presentConnections(state)}
          />
        ) : space === "projects" ? (
          <ProjectsScreen
            onProjectSelected={selectProject}
            onRefreshPressed={refreshProjects}
            state={presentProjects(state)}
          />
        ) : space === "tasks" ? (
          <TasksScreen
            onBucketSelected={selectBucket}
            onRefreshPressed={refresh}
            state={presentTasks(state)}
          />
        ) : (
          <DashboardScreen onRefreshPressed={refresh} state={presentDashboard(state)} />
        )}
      </View>
      <View style={styles.tabBar}>
        {spaces.map((candidate) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: candidate.id === space }}
            key={candidate.id}
            onPress={() => selectSpace(candidate.id)}
            style={styles.tab}
          >
            <Text style={[styles.tabLabel, candidate.id === space ? styles.tabLabelSelected : null]}>
              {candidate.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
