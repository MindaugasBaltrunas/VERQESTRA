import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

import { ConnectionBanner } from "../components/ConnectionBanner";
import type { DashboardViewProps } from "../core";

/**
 * Read-only AG Loop Dashboard. The screen renders the presenter's view state and
 * owns no business rule: there is no control here that could mutate AG Loop.
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
    gap: 6,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
    color: "#6b6b6b",
  },
  currentTask: {
    fontSize: 16,
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  rowLabel: {
    fontSize: 14,
  },
  rowValue: {
    fontSize: 14,
    fontWeight: "600",
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
  footer: {
    fontSize: 12,
    color: "#6b6b6b",
  },
});

export function DashboardScreen({ state, onRefreshPressed }: DashboardViewProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>{state.title}</Text>
      </View>
      <ConnectionBanner onRetryPressed={onRefreshPressed} state={state.connection} />
      {state.showLoadingPlaceholder ? (
        <View style={styles.placeholder}>
          <ActivityIndicator accessibilityLabel="Loading dashboard" size="large" />
          <Text style={styles.placeholderText}>Reading the AG Loop dashboard…</Text>
        </View>
      ) : state.showUnavailablePlaceholder ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>{state.unavailableLabel}</Text>
        </View>
      ) : state.isEmpty ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>AG Loop is idle: no task, queue entry or review.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>CURRENT TASK</Text>
            <Text style={styles.currentTask}>{state.currentTaskLabel}</Text>
            <Text style={styles.footer}>{state.currentTaskState}</Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>QUEUES</Text>
            {state.queueRows.map((row) => (
              <View key={row.bucket} style={styles.row}>
                <Text style={styles.rowLabel}>{row.label}</Text>
                <Text style={styles.rowValue}>{row.count}</Text>
              </View>
            ))}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>RUNTIME</Text>
            {state.runtimeRows.map((row) => (
              <View key={row.name} style={styles.row}>
                <Text style={styles.rowLabel}>{row.name}</Text>
                <Text style={styles.rowValue}>{row.status}</Text>
              </View>
            ))}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>REVIEW</Text>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Awaiting human review</Text>
              <Text style={styles.rowValue}>{state.reviewCount}</Text>
            </View>
          </View>

          {state.updatedAtLabel ? (
            <Text style={styles.footer}>Updated {state.updatedAtLabel}</Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
