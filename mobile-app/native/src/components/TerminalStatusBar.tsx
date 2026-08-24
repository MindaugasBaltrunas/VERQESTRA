import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import type { TerminalConnectionViewState } from "../core";

/**
 * Stream and session status for the mobile terminal. It renders the presenter's
 * decision as-is; no link or session state is derived here.
 */
export type TerminalStatusBarProps = Readonly<{
  connection: TerminalConnectionViewState;
  sessionLabel: string;
  statusLabel: string;
}>;

const linkColors = {
  disconnected: "#6b6b6b",
  connecting: "#6b6b6b",
  live: "#1f7a3d",
  reconnecting: "#a86a00",
  offline: "#98252b",
} as const;

const styles = StyleSheet.create({
  bar: {
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
  spacer: {
    flex: 1,
  },
  session: {
    fontSize: 12,
    color: "#6b6b6b",
    flexShrink: 1,
    textAlign: "right",
  },
  stale: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    fontSize: 12,
    color: "#a86a00",
  },
});

export function TerminalStatusBar({ connection, sessionLabel, statusLabel }: TerminalStatusBarProps) {
  return (
    <View accessibilityLabel={statusLabel}>
      <View style={styles.bar}>
        <View
          accessibilityLabel={`Terminal stream ${connection.state}`}
          style={[styles.dot, { backgroundColor: linkColors[connection.state] }]}
        />
        <Text style={styles.label}>{connection.label}</Text>
        <View style={styles.spacer} />
        {connection.showActivity ? <ActivityIndicator accessibilityLabel="Connecting" size="small" /> : null}
        <Text style={styles.session}>{sessionLabel}</Text>
      </View>
      {connection.stale ? (
        <Text style={styles.stale}>Showing the last output received.</Text>
      ) : null}
    </View>
  );
}
