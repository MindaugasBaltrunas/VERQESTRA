import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ConnectionBanner } from "../components/ConnectionBanner";
import type { ProjectsViewProps } from "../core";

/**
 * Read-only Projects screen: the registered projects, what each is bound to, and
 * the repository state of the selected one. Selecting a project is the only
 * intent the screen carries, and it changes nothing on the host — it decides
 * which project's repository state is read next.
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
  project: {
    gap: 2,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#d0d0d0",
  },
  projectSelected: {
    borderColor: "#1f2933",
    backgroundColor: "#f2f4f6",
  },
  projectName: {
    fontSize: 16,
    fontWeight: "600",
  },
  projectDetail: {
    fontSize: 13,
  },
  detail: {
    fontSize: 12,
    color: "#6b6b6b",
  },
  error: {
    fontSize: 12,
    color: "#98252b",
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

export function ProjectsScreen({
  state,
  onRefreshPressed,
  onProjectSelected,
}: ProjectsViewProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>{state.title}</Text>
      </View>
      <ConnectionBanner
        channelName="Projects"
        onRetryPressed={onRefreshPressed}
        state={state.connection}
      />
      {state.showLoadingPlaceholder ? (
        <View style={styles.placeholder}>
          <ActivityIndicator accessibilityLabel="Loading projects" size="large" />
          <Text style={styles.placeholderText}>Reading the registered projects…</Text>
        </View>
      ) : state.showUnavailablePlaceholder ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>{state.unavailableLabel}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>PROJECTS</Text>
            {state.isEmpty ? (
              <Text style={styles.placeholderText}>{state.emptyLabel}</Text>
            ) : null}
            {state.rows.map((row) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: row.selected }}
                key={row.key}
                onPress={() => onProjectSelected(row.projectId)}
                style={[styles.project, row.selected ? styles.projectSelected : null]}
              >
                <Text style={styles.projectName}>{row.name}</Text>
                <Text style={styles.projectDetail}>{row.repositoryLabel}</Text>
                <Text style={styles.projectDetail}>{row.branchLabel}</Text>
                <Text style={styles.detail}>{row.agLoopUiLabel}</Text>
              </Pressable>
            ))}
            {state.hiddenCount > 0 ? (
              <Text style={styles.detail}>
                {`Showing ${state.rows.length} of ${state.totalCount} registered projects`}
              </Text>
            ) : null}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>REPOSITORY</Text>
            {state.repository.available ? (
              <View style={styles.section}>
                <Text style={styles.projectDetail}>{state.repository.repositoryLabel}</Text>
                <Text style={styles.projectDetail}>{state.repository.branchLabel}</Text>
                <Text style={styles.detail}>{state.repository.dirtyLabel}</Text>
                <Text style={styles.detail}>{state.repository.divergenceLabel}</Text>
                {state.repository.stale ? (
                  <Text style={styles.detail}>Showing the last known state.</Text>
                ) : null}
              </View>
            ) : (
              <Text style={styles.placeholderText}>{state.repository.unavailableLabel}</Text>
            )}
            {state.repository.errorMessage ? (
              <Text style={styles.error}>{state.repository.errorMessage}</Text>
            ) : null}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
