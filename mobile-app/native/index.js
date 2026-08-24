// Expo entry point. Kept CommonJS on purpose: Metro/Babel load this file with
// `require`, so the native package intentionally has no `"type": "module"`.
const { registerRootComponent } = require("expo");
const App = require("./src/App").default;

registerRootComponent(App);
