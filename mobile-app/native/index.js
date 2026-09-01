// Expo entry point. Kept CommonJS on purpose: Metro/Babel load this file with
// `require`, so the native package intentionally has no `"type": "module"`.
const { registerRootComponent } = require("expo");
const { createElement } = require("react");
const App = require("./src/App").default;
const { createNativeAppProps } = require("./src/composition/native-runtime");

// Composition happens once, here. `App` constructs no port of its own, so what
// the native composition root hands it is the only thing that decides which
// spaces are live and which report themselves unwired.
const props = createNativeAppProps();

function Root() {
  return createElement(App, props);
}

registerRootComponent(Root);
