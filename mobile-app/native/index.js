// Expo entry point. Kept CommonJS on purpose: Metro/Babel load this file with
// `require`, so the native package intentionally has no `"type": "module"`.
const { createElement } = require("react");
const { registerRootComponent } = require("expo");
const App = require("./src/App").default;
const { createNativeAppProps } = require("./src/composition/native-runtime");

// Composition happens once, here: which ports this installation has and which
// host they talk to is a property of the installation, not of a render. A
// registered `App` with no props could never receive a port, however many
// adapters landed behind it.
const props = createNativeAppProps();

function Root() {
  return createElement(App, props);
}

registerRootComponent(Root);
