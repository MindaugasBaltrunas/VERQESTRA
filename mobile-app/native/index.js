// Expo entry point. Kept CommonJS on purpose: Metro/Babel load this file with
// `require`, so the native package intentionally has no `"type": "module"`.
const { createElement } = require("react");
const { registerRootComponent } = require("expo");
const App = require("./src/App").default;

/**
 * The entry point is the injection point. `App` takes every port through
 * `AppProps`, so this file decides what it receives. Registering `App` as the
 * root component directly, the way this entry used to, handed it the native
 * launcher's initialProps instead — which are not `AppProps` at all.
 *
 * What the native composition can build today is transport level only
 * (`src/composition/native-runtime.ts`: an HTTP transport over `fetch` and a
 * WebSocket factory over React Native's `WebSocket`). No `AppProps` port has an
 * adapter standing on those transports yet:
 *
 * - `agLoopReads`, `sessionReviewReads`, `connectionsReads`, `projectsReads` need
 *   the gateway read adapters, which are not written yet.
 * - `terminal` is all-or-nothing (`MobileTerminalPorts`) and its `credentials`
 *   (task 119), `writeGate` (task 120) and `speech` (task 121) adapters are
 *   missing, so `createGatewayHttpClient` / `createTerminalStreamClient` cannot
 *   be called at all — they take those ports as arguments and never invent them.
 *
 * Hence an empty props object rather than stubs: a fabricated port would make a
 * screen claim a channel it does not have. The screens already report what is
 * unwired, and that is the designed behaviour, not a defect.
 */
function createAppProps() {
  return {};
}

function Root() {
  return createElement(App, createAppProps());
}

registerRootComponent(Root);
