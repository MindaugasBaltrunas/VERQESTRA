import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Node-only source checks for the push-to-talk shell: this suite never loads
// React, React Native or a speech SDK, so the voice surface stays verifiable in
// CI without a device toolchain. What the controls may do is decided by
// `presentTerminal` and `VoiceCaptureController`, which the core tests cover —
// these assertions only keep those decisions, and the recogniser itself, out of
// the shell.
//
// NUKRYPIMAI: (1) `process.cwd()` → `__dirname`, žr. `core-seam.test.ts`; (2) MVA → MVC
// moduliai — `composition/voice-capture-controller` → `controller/…`, o `VoiceCapturePhase`,
// `TerminalVoicePrivacy` ir `TerminalVoiceViewState` gyvena `view/terminal-view-state`, nes
// tipai iškelti iš presenterių (žr. `mobile-app/src/view/ag-loop-view-state.ts`).

const nativeRoot = path.resolve(__dirname, "..", "..");
const shellRoot = path.join(nativeRoot, "src");
/** The MVC core lives one package up; it is read here, never imported. */
const coreSourceRoot = path.resolve(nativeRoot, "..", "src");

async function readShellFile(relative: string): Promise<string> {
  return readFile(path.join(shellRoot, relative), "utf8");
}

async function readCoreFile(relative: string): Promise<string> {
  return readFile(path.join(coreSourceRoot, relative), "utf8");
}

const screen = "screens/TerminalScreen.tsx";

/**
 * Every module a shell could reach a recogniser through. Push-to-talk must
 * arrive as an injected port: a screen that imported one of these would hold a
 * microphone the core's consent and confirmation rules never see.
 */
const speechModules: readonly string[] = [
  "@react-native-voice/voice",
  "react-native-voice",
  "expo-speech",
  "expo-speech-recognition",
  "react-native-speech-recognition",
  "@react-native-community/voice",
];

/** The body of a `const name = useCallback(...)` declaration, brackets balanced. */
function callbackBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  assert.notEqual(start, -1, `${name} is not defined as a callback`);
  const end = source.indexOf("\n  }, [", start);
  assert.notEqual(end, -1, `${name} has no dependency list`);
  return source.slice(start, end);
}

test("the transcript is an editable field the presenter controls, not static text", async () => {
  const text = await readShellFile(screen);

  assert.match(text, /<TextInput[\s\S]*?accessibilityLabel="Recognised command"[\s\S]*?\/>/);
  const field = /<TextInput[\s\S]*?accessibilityLabel="Recognised command"[\s\S]*?\/>/.exec(text);
  assert.ok(field, "the recognised command is not rendered as an input");
  // Editability is the presenter's answer, never the screen's: a field that is
  // editable in the wrong phase is a transcript the operator can change after
  // the controller stopped comparing it.
  assert.match(field[0], /editable=\{state\.voice\.editable\}/);
  assert.match(field[0], /onChangeText=\{onVoiceDraftChanged\}/);
  assert.match(field[0], /value=\{state\.voice\.draft\}/);
});

test("the hold button emits press-in and press-out and is inert when capture is blocked", async () => {
  const text = await readShellFile(screen);

  assert.match(text, /onPressIn=\{onVoiceHoldStart\}/);
  assert.match(text, /onPressOut=\{onVoiceHoldEnd\}/);
  assert.match(text, /disabled=\{!state\.voice\.canCapture\}/);
  // A blocked hold says why, rather than dimming a control for no stated reason.
  assert.match(text, /state\.voice\.captureBlockedReason/);
});

test("sending a transcript is a separate control the presenter alone enables", async () => {
  const text = await readShellFile(screen);

  assert.match(text, /disabled=\{!state\.voice\.canConfirm\}/);
  assert.match(text, /onPress=\{onVoiceConfirmed\}/);
  assert.match(text, /Send transcript/);
  assert.match(text, /state\.voice\.confirmBlockedReason/);
  // Live recogniser text is read-only by construction: it is rendered as text,
  // so there is nothing to type into and nothing to send.
  assert.match(text, /state\.voice\.listening \? \([\s\S]{0,120}<Text/);
});

test("discarding is offered whenever there is a capture to abandon", async () => {
  const text = await readShellFile(screen);

  // A press-out lost to a gesture cancel leaves a capture with no transcript,
  // so tying discard to `confirmationRequired` would strand it.
  assert.match(text, /state\.voice\.canDiscard \? \(/);
  assert.match(text, /onPress=\{onVoiceCancelled\}/);
  const discard = text.indexOf("state.voice.canDiscard");
  const confirmation = text.lastIndexOf("state.voice.confirmationRequired");
  assert.ok(discard !== -1 && confirmation !== -1);
});

test("the screen names no speech backend of its own", async () => {
  const text = await readShellFile(screen);

  for (const literal of [/["'`]on-device["'`]/, /["'`]cloud["'`]/i, /["'`]Cloud["'`]/]) {
    assert.doesNotMatch(text, literal, `${screen} words the privacy claim itself`);
  }
  // It renders the claim the core computed instead.
  assert.match(text, /state\.voice\.privacy\.badge/);
  assert.match(text, /state\.voice\.privacy\.label/);
  assert.match(text, /state\.voice\.privacy\.consentPrompt/);
  assert.match(text, /state\.voice\.privacy\.consentGranted/);
});

test("neither the terminal screen nor the root component imports a speech SDK", async () => {
  for (const file of [screen, "App.tsx", "composition/create-app-runtime.ts"]) {
    const text = await readShellFile(file);
    for (const module of speechModules) {
      assert.ok(!text.includes(module), `${file} reaches a recogniser directly: ${module}`);
    }
  }
  // The recogniser arrives as a port the composition root is handed.
  const runtime = await readShellFile("composition/create-app-runtime.ts");
  assert.match(runtime, /speech\?:\s*SpeechRecognitionPort/);
  assert.match(runtime, /speechConsent\?:\s*SpeechConsentPort/);
  assert.match(runtime, /new PushToTalkRecorder\(options\.speech,\s*options\.speechConsent\)/);

  const app = await readShellFile("App.tsx");
  assert.match(app, /terminal\?:\s*MobileTerminalPorts/);
});

test("the root component sends a transcript only through the voice controller", async () => {
  const app = await readShellFile("App.tsx");
  const confirm = callbackBody(app, "confirmVoiceDraft");

  assert.match(confirm, /voice\.confirm\(voiceDraft\)/);
  // The controller compares the text on screen with the transcript it recognised
  // and clears the panel itself; a shell that dispatched the clearing would drop
  // a transcript whose delivery failed.
  assert.ok(!confirm.includes("voice.cancelled"), "the shell clears the panel behind the controller");
  assert.ok(!confirm.includes("submitConfirmedVoice"), "the shell bypasses the confirmation seam");
  assert.ok(!confirm.includes("submitKeyboard"), "a dictated command was sent as a typed one");
});

test("every way of leaving the terminal takes the pending capture with it", async () => {
  const app = await readShellFile("App.tsx");

  for (const exit of ["closeSession", "detachStream", "selectSpace"]) {
    const body = callbackBody(app, exit);
    assert.match(body, /voice\?\.cancel\(\)/, `${exit} leaves the capture running`);
  }
  // Switching space unmounts the screen that authorised the microphone, so its
  // press-out never arrives; only leaving the terminal cancels.
  assert.match(callbackBody(app, "selectSpace"), /next !== "terminal"/);
});

test("the shell reaches every voice symbol through the core seam, and the barrel exports each", async () => {
  const seam = await readShellFile("core.ts");
  const barrel = await readCoreFile("index.ts");

  const voiceSymbols: ReadonlyArray<Readonly<{ symbol: string; module: string }>> = [
    { symbol: "PushToTalkRecorder", module: "adapters/speech/push-to-talk-recorder" },
    { symbol: "SpeechCaptureError", module: "adapters/speech/push-to-talk-recorder" },
    { symbol: "SecureCloudConsentStore", module: "adapters/speech/cloud-consent-store" },
    { symbol: "VoiceCaptureController", module: "controller/voice-capture-controller" },
    { symbol: "VoiceCaptureError", module: "controller/voice-capture-controller" },
    { symbol: "VoiceSubmissionTarget", module: "controller/voice-capture-controller" },
    { symbol: "SpeechCapability", module: "model/ports" },
    { symbol: "SpeechCaptureHandle", module: "model/ports" },
    { symbol: "SpeechConsentPort", module: "model/ports" },
    { symbol: "SpeechFinalResult", module: "model/ports" },
    { symbol: "SpeechPartialResult", module: "model/ports" },
    { symbol: "SpeechRecognitionPort", module: "model/ports" },
    { symbol: "SpeechTranscriptionMode", module: "model/voice" },
    { symbol: "SpeechUnavailableReason", module: "model/voice" },
    { symbol: "VoiceAvailability", module: "model/voice" },
    { symbol: "VoiceCaptureFailureCode", module: "model/voice" },
    { symbol: "VoiceCapturePhase", module: "view/terminal-view-state" },
    { symbol: "TerminalVoicePrivacy", module: "view/terminal-view-state" },
    { symbol: "TerminalVoiceViewState", module: "view/terminal-view-state" },
  ];

  for (const { symbol, module } of voiceSymbols) {
    assert.match(seam, new RegExp(`\\b${symbol}\\b`), `core.ts does not re-export ${symbol}`);
    assert.ok(
      barrel.includes(`./${module}.js`),
      `the public barrel does not re-export ${module}, so ${symbol} is unreachable`,
    );
    const source = await readCoreFile(`${module}.ts`);
    assert.match(
      source,
      new RegExp(`export\\s+(?:abstract\\s+)?(?:class|interface|type|const|function)\\s+${symbol}\\b`),
      `${module}.ts does not export ${symbol}`,
    );
  }

  // The seam is the only door: the screens take the view contract from it too.
  assert.match(await readShellFile(screen), /from\s+"\.\.\/core"/);
});
