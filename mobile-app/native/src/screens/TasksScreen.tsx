import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ConnectionBanner } from "../components/ConnectionBanner";
import type { TasksViewProps } from "../core";

/**
 * Read-only AG Loop Tasks. Bucket selection is the only intent this screen
 * emits; task files are listed, never moved, retried or edited from mobile.
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
  tabs: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#9a9a9a",
  },
  tabSelected: {
    backgroundColor: "#1f2933",
    borderColor: "#1f2933",
  },
  tabLabel: {
    fontSize: 13,
    color: "#1f2933",
  },
  tabLabelSelected: {
    color: "#ffffff",
    fontWeight: "600",
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  taskRow: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
  },
  taskName: {
    fontSize: 14,
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
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 12,
    color: "#6b6b6b",
  },
});

export function TasksScreen({ state, onRefreshPressed, onBucketSelected }: TasksViewProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>{state.title}</Text>
      </View>
      <ConnectionBanner onRetryPressed={onRefreshPressed} state={state.connection} />

      <ScrollView
        contentContainerStyle={styles.tabs}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        {state.tabs.map((tab) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: tab.selected }}
            key={tab.bucket}
            onPress={() => onBucketSelected(tab.bucket)}
            style={[styles.tab, tab.selected ? styles.tabSelected : null]}
          >
            <Text style={[styles.tabLabel, tab.selected ? styles.tabLabelSelected : null]}>
              {tab.count === null ? tab.label : `${tab.label} ${tab.count}`}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {state.showLoadingPlaceholder ? (
        <View style={styles.placeholder}>
          <ActivityIndicator accessibilityLabel="Loading tasks" size="large" />
          <Text style={styles.placeholderText}>Reading {state.selectedBucket}…</Text>
        </View>
      ) : state.showUnavailablePlaceholder ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>{state.unavailableLabel}</Text>
        </View>
      ) : state.isEmpty ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>{state.emptyLabel}</Text>
        </View>
      ) : (
        <FlatList
          contentContainerStyle={styles.list}
          data={state.rows}
          keyExtractor={(item) => item}
          ListFooterComponent={state.hiddenCount > 0 ? (
            <Text style={styles.footer}>
              {state.hiddenCount} more of {state.totalCount} not shown
            </Text>
          ) : null}
          renderItem={({ item }) => (
            <View style={styles.taskRow}>
              <Text style={styles.taskName}>{item}</Text>
            </View>
          )}
        />
      )}
    </View>
  );
}
