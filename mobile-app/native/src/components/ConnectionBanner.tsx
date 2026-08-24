import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type {
  AgLoopConnectionViewState,
  ConnectionsChannelViewState,
  ProjectsChannelViewState,
  SessionReviewConnectionViewState,
} from "../core";

/**
 * Reconnect badge shared by the read-only screens. It renders the presenter's
 * decision as-is; the link state is never derived here.
 *
 * Every read-only channel presents the same badge shape, so the banner takes any
 * of them. `channelName` names the channel in the accessibility label alone, and
 * defaults to the AG Loop wording the existing screens already announce.
 */
export type ConnectionBannerProps = Readonly<{
  state:
    | AgLoopConnectionViewState
    | SessionReviewConnectionViewState
    | ConnectionsChannelViewState
    | ProjectsChannelViewState;
  onRetryPressed(): void;
  channelName?: string;
}>;

const linkColors = {
  connecting: "#6b6b6b",
  connected: "#1f7a3d",
  degraded: "#a86a00",
  offline: "#98252b",
} as const;

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d0d0d0",
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    flexShrink: 1,
  },
  detail: {
    fontSize: 12,
    color: "#6b6b6b",
    flexShrink: 1,
  },
  spacer: {
    flex: 1,
  },
  retry: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#6b6b6b",
  },
  retryLabel: {
    fontSize: 12,
    fontWeight: "600",
  },
  messages: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 2,
  },
  error: {
    fontSize: 12,
    color: "#98252b",
  },
});

export function ConnectionBanner({
  state,
  onRetryPressed,
  channelName = "AG Loop",
}: ConnectionBannerProps) {
  return (
    <View>
      <View style={styles.banner}>
        <View
          accessibilityLabel={`${channelName} link ${state.link}`}
          style={[styles.dot, { backgroundColor: linkColors[state.link] }]}
        />
        <Text style={styles.label}>{state.label}</Text>
        <View style={styles.spacer} />
        {state.refreshing ? <ActivityIndicator accessibilityLabel="Refreshing" size="small" /> : null}
        {state.canRetry ? (
          <Pressable accessibilityRole="button" onPress={onRetryPressed} style={styles.retry}>
            <Text style={styles.retryLabel}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
      {state.stale || state.errorMessage ? (
        <View style={styles.messages}>
          {state.stale ? <Text style={styles.detail}>Showing the last known state.</Text> : null}
          {state.errorMessage ? <Text style={styles.error}>{state.errorMessage}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
