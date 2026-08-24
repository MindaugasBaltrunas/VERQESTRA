import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { TerminalStatusBar } from "../components/TerminalStatusBar";
import type { TerminalActionId, TerminalViewProps } from "../core";

/**
 * Mobile-controlled Agent Terminal (Claude Code / Codex).
 *
 * The screen renders the presenter's view state and owns no rule: which
 * provider may be picked, which lifecycle action is enabled, whether the
 * composer accepts input and how much of the output buffer is rendered are all
 * decided in the MVC core. Output text is displayed verbatim — it was already
 * sanitised on the host — and the list is virtualised, so a long session never
 * mounts more rows than the presenter's window.
 *
 * Push-to-talk is rendered the same way: the hold button, the privacy badge, the
 * consent ask and the transcript editor only emit intents. The screen has no way
 * to send recognised text — sending is a separate, explicitly confirmed intent —
 * and it names no speech backend of its own, so the privacy claim on screen is
 * always the one the core computed.
 */

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 2,
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
  },
  subtitle: {
    fontSize: 13,
    color: "#1f2933",
  },
  notice: {
    fontSize: 12,
    color: "#6b6b6b",
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#9a9a9a",
  },
  chipSelected: {
    backgroundColor: "#1f2933",
    borderColor: "#1f2933",
  },
  chipDisabled: {
    opacity: 0.4,
  },
  chipLabel: {
    fontSize: 13,
    color: "#1f2933",
  },
  chipLabelSelected: {
    color: "#ffffff",
    fontWeight: "600",
  },
  action: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#6b6b6b",
  },
  actionDestructive: {
    borderColor: "#98252b",
  },
  actionDisabled: {
    opacity: 0.4,
  },
  actionLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#1f2933",
  },
  actionLabelDestructive: {
    color: "#98252b",
  },
  banner: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    fontSize: 12,
    color: "#a86a00",
  },
  error: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    fontSize: 12,
    color: "#98252b",
  },
  transcript: {
    flex: 1,
  },
  transcriptContent: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  line: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#1f2933",
  },
  placeholder: {
    padding: 24,
    alignItems: "center",
  },
  placeholderText: {
    fontSize: 14,
    color: "#6b6b6b",
    textAlign: "center",
  },
  voice: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#d0d0d0",
  },
  voiceLabel: {
    fontSize: 13,
    fontWeight: "600",
  },
  voiceDraft: {
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#9a9a9a",
    fontSize: 13,
    color: "#1f2933",
  },
  voiceHold: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    backgroundColor: "#1f2933",
  },
  voiceHoldDisabled: {
    opacity: 0.4,
  },
  voiceHoldLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#ffffff",
  },
  voiceBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  voiceBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#6b6b6b",
    fontSize: 12,
    fontWeight: "600",
    color: "#1f2933",
  },
  voicePrivacyLabel: {
    flex: 1,
    fontSize: 12,
    color: "#6b6b6b",
  },
  voiceStatus: {
    fontSize: 12,
    color: "#6b6b6b",
  },
  voicePartial: {
    fontSize: 13,
    fontStyle: "italic",
    color: "#6b6b6b",
  },
  voiceWarning: {
    fontSize: 12,
    color: "#a86a00",
  },
  voiceError: {
    fontSize: 12,
    color: "#98252b",
  },
  composer: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#d0d0d0",
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#9a9a9a",
    fontSize: 14,
  },
  inputDisabled: {
    backgroundColor: "#f2f2f2",
    color: "#6b6b6b",
  },
  send: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: "#1f2933",
  },
  sendDisabled: {
    opacity: 0.4,
  },
  sendLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#ffffff",
  },
  composerFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  composerHint: {
    flex: 1,
    fontSize: 12,
    color: "#6b6b6b",
  },
  counter: {
    fontSize: 12,
    color: "#6b6b6b",
  },
  counterTooLong: {
    color: "#98252b",
  },
});

export function TerminalScreen({
  state,
  onProviderSelected,
  onComposerChanged,
  onStartPressed,
  onSubmitPressed,
  onInterruptPressed,
  onClosePressed,
  onDetachPressed,
  onVoiceHoldStart,
  onVoiceHoldEnd,
  onVoiceDraftChanged,
  onVoiceAcknowledged,
  onVoiceCloudConsentChanged,
  onVoiceConfirmed,
  onVoiceCancelled,
}: TerminalViewProps) {
  const actionHandlers: Readonly<Record<TerminalActionId, () => void>> = {
    start: onStartPressed,
    interrupt: onInterruptPressed,
    close: onClosePressed,
    detach: onDetachPressed,
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>{state.title}</Text>
        <Text style={styles.subtitle}>{state.providerLabel}</Text>
        <Text style={styles.notice}>{state.scopeNotice}</Text>
      </View>

      <TerminalStatusBar
        connection={state.connection}
        sessionLabel={state.sessionLabel}
        statusLabel={state.statusLabel}
      />

      <View style={styles.row}>
        {state.providers.map((option) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !option.enabled, selected: option.selected }}
            disabled={!option.enabled}
            key={option.provider}
            onPress={() => onProviderSelected(option.provider)}
            style={[
              styles.chip,
              option.selected ? styles.chipSelected : null,
              option.enabled ? null : styles.chipDisabled,
            ]}
          >
            <Text style={[styles.chipLabel, option.selected ? styles.chipLabelSelected : null]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.row}>
        {state.actions.map((action) => (
          <Pressable
            accessibilityHint={action.hint}
            accessibilityRole="button"
            accessibilityState={{ disabled: !action.enabled }}
            disabled={!action.enabled}
            key={action.id}
            onPress={actionHandlers[action.id]}
            style={[
              styles.action,
              action.destructive ? styles.actionDestructive : null,
              action.enabled ? null : styles.actionDisabled,
            ]}
          >
            <Text style={[styles.actionLabel, action.destructive ? styles.actionLabelDestructive : null]}>
              {action.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {state.historyTruncated ? (
        <Text style={styles.banner}>{state.historyTruncatedLabel}</Text>
      ) : null}
      {state.hiddenLineCount > 0 ? (
        <Text style={styles.banner}>{state.hiddenLineLabel}</Text>
      ) : null}
      {state.errorMessage ? <Text style={styles.error}>{state.errorMessage}</Text> : null}

      {state.isEmpty ? (
        <View style={[styles.transcript, styles.placeholder]}>
          <Text style={styles.placeholderText}>{state.emptyLabel}</Text>
        </View>
      ) : (
        <FlatList
          contentContainerStyle={styles.transcriptContent}
          data={state.rows}
          initialNumToRender={40}
          keyExtractor={(item) => item.key}
          maxToRenderPerBatch={40}
          removeClippedSubviews
          renderItem={({ item }) => <Text style={styles.line}>{item.text}</Text>}
          style={styles.transcript}
          windowSize={9}
        />
      )}

      <View style={styles.voice}>
        <View style={styles.voiceBadgeRow}>
          <Text style={styles.voiceBadge}>{state.voice.privacy.badge}</Text>
          <Text style={styles.voicePrivacyLabel}>{state.voice.privacy.label}</Text>
        </View>

        {state.voice.privacy.consentRequired ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ checked: state.voice.privacy.consentGranted }}
            onPress={() => onVoiceCloudConsentChanged(!state.voice.privacy.consentGranted)}
            style={styles.action}
          >
            <Text style={styles.actionLabel}>
              {state.voice.privacy.consentPrompt ?? "Withdraw transcription consent"}
            </Text>
          </Pressable>
        ) : null}

        <Pressable
          accessibilityHint={state.voice.holdHint}
          accessibilityRole="button"
          accessibilityState={{ busy: state.voice.busy, disabled: !state.voice.canCapture }}
          disabled={!state.voice.canCapture}
          onPressIn={onVoiceHoldStart}
          onPressOut={onVoiceHoldEnd}
          style={[styles.voiceHold, state.voice.canCapture ? null : styles.voiceHoldDisabled]}
        >
          <Text style={styles.voiceHoldLabel}>Hold to talk</Text>
        </Pressable>

        <Text style={styles.voiceStatus}>{state.voice.statusLabel}</Text>
        {state.voice.captureBlockedReason ? (
          <Text style={styles.voiceStatus}>{state.voice.captureBlockedReason}</Text>
        ) : null}
        {/* Live recogniser text is read-only by construction: there is no input to
            type into and no control that could send it. */}
        {state.voice.listening ? (
          <Text style={styles.voicePartial}>{state.voice.partial}</Text>
        ) : null}
        {state.voice.errorMessage ? (
          <Text style={styles.voiceError}>{state.voice.errorMessage}</Text>
        ) : null}

        {state.voice.confirmationRequired ? (
          <>
            <Text style={styles.voiceLabel}>{state.voice.confirmationLabel}</Text>
            <TextInput
              accessibilityLabel="Recognised command"
              editable={state.voice.editable}
              multiline
              onChangeText={onVoiceDraftChanged}
              style={styles.voiceDraft}
              value={state.voice.draft}
            />
            {state.voice.lowConfidenceWarning ? (
              <Text style={styles.voiceWarning}>{state.voice.lowConfidenceWarning}</Text>
            ) : null}
            {state.voice.acknowledgementRequired ? (
              <Pressable
                accessibilityRole="button"
                onPress={onVoiceAcknowledged}
                style={styles.action}
              >
                <Text style={styles.actionLabel}>{state.voice.acknowledgementLabel}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}

        {/* Discard is offered in every phase but `idle`, not only under a finished
            transcript: a press-out lost to a gesture cancel would otherwise leave
            a capture running with no control able to end it. */}
        {state.voice.canDiscard ? (
          <>
            <View style={styles.composerRow}>
              {state.voice.confirmationRequired ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !state.voice.canConfirm }}
                  disabled={!state.voice.canConfirm}
                  onPress={onVoiceConfirmed}
                  style={[styles.send, state.voice.canConfirm ? null : styles.sendDisabled]}
                >
                  <Text style={styles.sendLabel}>Send transcript</Text>
                </Pressable>
              ) : null}
              <Pressable accessibilityRole="button" onPress={onVoiceCancelled} style={styles.action}>
                <Text style={styles.actionLabel}>Discard</Text>
              </Pressable>
            </View>
            {state.voice.confirmationRequired ? (
              <Text style={styles.voiceStatus}>{state.voice.confirmBlockedReason ?? ""}</Text>
            ) : null}
          </>
        ) : null}
      </View>

      <View style={styles.composer}>
        <View style={styles.composerRow}>
          <TextInput
            accessibilityLabel="Terminal command"
            editable={state.composer.editable}
            multiline
            onChangeText={onComposerChanged}
            placeholder={state.composer.placeholder}
            style={[styles.input, state.composer.editable ? null : styles.inputDisabled]}
            value={state.composer.draft}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !state.composer.canSend }}
            disabled={!state.composer.canSend}
            onPress={onSubmitPressed}
            style={[styles.send, state.composer.canSend ? null : styles.sendDisabled]}
          >
            <Text style={styles.sendLabel}>Send</Text>
          </Pressable>
        </View>
        <View style={styles.composerFooter}>
          <Text style={styles.composerHint}>{state.composer.blockedReason ?? ""}</Text>
          <Text style={[styles.counter, state.composer.tooLong ? styles.counterTooLong : null]}>
            {state.composer.characterCount}/{state.composer.maxLength}
          </Text>
        </View>
      </View>
    </View>
  );
}
