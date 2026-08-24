import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

import { ConnectionBanner } from "../components/ConnectionBanner";
import type { ConnectionsViewProps } from "../core";

/**
 * Read-only Connections screen: Claude Code and Codex host state, and the host
 * GitHub connection. The screen renders the presenter's view state and owns no
 * business rule — there is no control here that could connect, disconnect or
 * authorize anything, because those are host-side actions.
 */

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
  },
  content: {
    padding: 16,
    gap: 20,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
    color: "#6b6b6b",
  },
  row: {
    gap: 2,
    paddingVertical: 6,
  },
  rowLabel: {
    fontSize: 16,
    fontWeight: "600",
  },
  rowStatus: {
    fontSize: 14,
  },
  rowStatusReady: {
    color: "#1f7a3d",
  },
  rowStatusAttention: {
    color: "#a86a00",
  },
  detail: {
    fontSize: 12,
    color: "#6b6b6b",
  },
  placeholder: {
    padding: 24,
    alignItems: "center",
    gap: 12,
  },
  placeholderText: {
    fontSize: 14,
    color: "#6b6b6b",
    textAlign: "center",
  },
});

export function ConnectionsScreen({ state, onRefreshPressed }: ConnectionsViewProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>{state.title}</Text>
      </View>
      <ConnectionBanner
        channelName="Connections"
        onRetryPressed={onRefreshPressed}
        state={state.connection}
      />
      {state.showLoadingPlaceholder ? (
        <View style={styles.placeholder}>
          <ActivityIndicator accessibilityLabel="Loading connections" size="large" />
          <Text style={styles.placeholderText}>Reading the host connection state…</Text>
        </View>
      ) : state.showUnavailablePlaceholder ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>{state.unavailableLabel}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>AGENT PROVIDERS</Text>
            {state.agents.isEmpty ? (
              <Text style={styles.placeholderText}>{state.agents.emptyLabel}</Text>
            ) : null}
            {state.agents.rows.map((row) => (
              <View key={row.provider} style={styles.row}>
                <Text style={styles.rowLabel}>{row.label}</Text>
                <Text
                  style={[
                    styles.rowStatus,
                    row.ready ? styles.rowStatusReady : null,
                    row.needsAttention ? styles.rowStatusAttention : null,
                  ]}
                >
                  {row.statusLabel}
                </Text>
                {row.detailLabel ? <Text style={styles.detail}>{row.detailLabel}</Text> : null}
              </View>
            ))}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>GITHUB</Text>
            <View style={styles.row}>
              <Text
                style={[
                  styles.rowStatus,
                  state.github.connected ? styles.rowStatusReady : null,
                  state.github.needsAttention ? styles.rowStatusAttention : null,
                ]}
              >
                {state.github.statusLabel}
              </Text>
              {state.github.accountLabel ? (
                <Text style={styles.detail}>{state.github.accountLabel}</Text>
              ) : null}
              {/* A statement, never a link: completing an authorization is host-side work. */}
              {state.github.authorizationLabel ? (
                <Text style={styles.detail}>{state.github.authorizationLabel}</Text>
              ) : null}
            </View>
          </View>
        </ScrollView>
      )}
    </View>
  );
}
