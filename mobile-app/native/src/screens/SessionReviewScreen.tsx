import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

import { ConnectionBanner } from "../components/ConnectionBanner";
import type { SessionReviewViewProps } from "../core";

/**
 * Read-only session review: git fingerprint, changed files, diff, gate evidence
 * and the optional AG audit. Every label, marker, clip and "not proven" wording
 * is decided by the presenter — this screen only renders it, and offers no
 * control that could merge, retry or edit the reviewed session.
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
  session: {
    fontSize: 16,
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 4,
  },
  rowLabel: {
    fontSize: 14,
  },
  rowValue: {
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
    textAlign: "right",
  },
  mono: {
    fontFamily: "monospace",
    fontSize: 12,
  },
  path: {
    fontFamily: "monospace",
    fontSize: 12,
    paddingVertical: 2,
  },
  filePath: {
    fontFamily: "monospace",
    fontSize: 13,
    fontWeight: "600",
  },
  hunkHeader: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#6b6b6b",
    paddingTop: 6,
  },
  diffLine: {
    fontFamily: "monospace",
    fontSize: 12,
  },
  added: {
    color: "#1f7a3d",
  },
  removed: {
    color: "#98252b",
  },
  meta: {
    color: "#6b6b6b",
  },
  verdict: {
    fontSize: 15,
    fontWeight: "700",
  },
  verdictPassed: {
    color: "#1f7a3d",
  },
  verdictBlocked: {
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
  footer: {
    fontSize: 12,
    color: "#6b6b6b",
  },
});

export function SessionReviewScreen({ state, onRefreshPressed }: SessionReviewViewProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>{state.title}</Text>
      </View>
      <ConnectionBanner
        channelName="Session review"
        onRetryPressed={onRefreshPressed}
        state={state.connection}
      />
      {state.showLoadingPlaceholder ? (
        <View style={styles.placeholder}>
          <ActivityIndicator accessibilityLabel="Loading session review" size="large" />
          <Text style={styles.placeholderText}>Reading the session review…</Text>
        </View>
      ) : state.showUnavailablePlaceholder ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>{state.unavailableLabel}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>SESSION</Text>
            <Text style={styles.session}>{state.sessionLabel}</Text>
            <Text style={styles.footer}>{state.sessionStateLabel}</Text>
            {state.observedAtLabel ? (
              <Text style={styles.footer}>Observed {state.observedAtLabel}</Text>
            ) : null}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>GIT FINGERPRINT</Text>
            {state.fingerprint.map((entry) => (
              <View key={entry.label} style={styles.row}>
                <Text style={styles.rowLabel}>{entry.label}</Text>
                <Text style={[styles.rowValue, entry.mono ? styles.mono : null]}>
                  {entry.value}
                </Text>
              </View>
            ))}
            <Text style={styles.footer}>{state.targetCleanLabel}</Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>GATES</Text>
            <Text
              style={[
                styles.verdict,
                state.gates.passed ? styles.verdictPassed : styles.verdictBlocked,
              ]}
            >
              {state.gates.verdictLabel}
            </Text>
            {state.gates.staleLabel ? (
              <Text style={styles.footer}>{state.gates.staleLabel}</Text>
            ) : null}
            {state.gates.rows.map((gate, index) => (
              <View key={`${index}:${gate.name}`} style={styles.row}>
                <Text style={styles.rowLabel}>{gate.label}</Text>
                <Text style={styles.rowValue}>
                  {gate.detailLabel === null
                    ? gate.statusLabel
                    : `${gate.statusLabel} · ${gate.detailLabel}`}
                </Text>
              </View>
            ))}
            {state.gates.missingGateNames.map((name, index) => (
              <View key={`${index}:${name}`} style={styles.row}>
                <Text style={styles.rowLabel}>{name}</Text>
                <Text style={styles.rowValue}>Not recorded</Text>
              </View>
            ))}
            {state.gates.recordedAtLabel ? (
              <Text style={styles.footer}>Recorded {state.gates.recordedAtLabel}</Text>
            ) : null}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>AG AUDIT</Text>
            <Text style={styles.rowLabel}>{state.audit.statusLabel}</Text>
            {state.audit.stale ? (
              <Text style={styles.footer}>Recorded for another commit.</Text>
            ) : null}
            {state.audit.rows.map((finding) => (
              <View key={finding.key} style={styles.section}>
                <Text style={styles.rowLabel}>
                  {finding.severityLabel} · {finding.locationLabel}
                </Text>
                <Text style={styles.footer}>{finding.message}</Text>
              </View>
            ))}
            {state.audit.hiddenCount > 0 ? (
              <Text style={styles.footer}>{state.audit.hiddenCount} more findings not shown</Text>
            ) : null}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>CHANGED FILES</Text>
            {state.changedFiles.map((path) => (
              <Text key={path} style={styles.path}>{path}</Text>
            ))}
            {state.changedFileHiddenCount > 0 ? (
              <Text style={styles.footer}>
                {state.changedFileHiddenCount} more of {state.changedFileTotalCount} not shown
              </Text>
            ) : null}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>DIFF</Text>
            <Text style={styles.footer}>{state.diff.summaryLabel}</Text>
            {state.diff.isEmpty ? (
              <Text style={styles.placeholderText}>{state.diff.emptyLabel}</Text>
            ) : null}
            {state.diff.files.map((file) => (
              <View key={file.key} style={styles.section}>
                <Text style={styles.filePath}>{file.path}</Text>
                <Text style={styles.footer}>{file.changeLabel}</Text>
                {file.binaryLabel ? <Text style={styles.footer}>{file.binaryLabel}</Text> : null}
                {file.hunks.map((hunk) => (
                  <View key={hunk.key}>
                    <Text style={styles.hunkHeader}>{hunk.header}</Text>
                    {hunk.lines.map((line) => (
                      <Text
                        key={line.key}
                        style={[
                          styles.diffLine,
                          line.kind === "added" ? styles.added : null,
                          line.kind === "removed" ? styles.removed : null,
                          line.kind === "meta" ? styles.meta : null,
                        ]}
                      >
                        {line.marker}{line.text}{line.clipped ? "…" : ""}
                      </Text>
                    ))}
                  </View>
                ))}
                {file.hiddenHunkLabel ? (
                  <Text style={styles.footer}>{file.hiddenHunkLabel}</Text>
                ) : null}
              </View>
            ))}
            {state.diff.truncationLabel ? (
              <Text style={styles.footer}>{state.diff.truncationLabel}</Text>
            ) : null}
            {state.diff.digestLabel ? (
              <Text style={styles.footer}>{state.diff.digestLabel}</Text>
            ) : null}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
