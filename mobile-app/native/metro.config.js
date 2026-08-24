const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
// The platform-independent MVC core package (`@verqestra/mobile-app`).
const corePackageRoot = path.resolve(projectRoot, "..");
// NUKRYPIMAS (gylis, ne elgesys): etalone šis paketas gulėjo `AG/mobile-app/native`, tad iki
// repo šaknies buvo TRYS lygiai. VERQESTRA'oje jis yra `mobile-app/native` — du.
const repoRoot = path.resolve(projectRoot, "..", "..");

const config = getDefaultConfig(projectRoot);

// The core lives outside this package, so Metro has to watch it and resolve
// modules from both the package-local and the workspace-root store. Only the
// core package and the workspace store are watched — watching the whole
// repository root would make Metro churn on the loop's own `vq/state`,
// `vq/logs` and `logs` traffic.
config.watchFolders = [corePackageRoot, path.resolve(repoRoot, "node_modules")];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(repoRoot, "node_modules"),
];
// `disableHierarchicalLookup` is deliberately NOT set: pnpm's isolated linker
// keeps transitive dependencies under `node_modules/.pnpm/*/node_modules`, which
// is only reachable through Metro's hierarchical walk-up.

// TEMPORARY runtime seam: `@verqestra/mobile-app` declares no `main`/`exports`,
// so Metro cannot resolve the bare specifier on its own. Run
// `pnpm --dir mobile-app build` before bundling — this points at the
// compiled output. Delete this mapping once the core package declares
// `exports`/`types`; the bare specifier then resolves without any seam.
config.resolver.extraNodeModules = {
  "@verqestra/mobile-app": path.resolve(corePackageRoot, "dist", "index.js"),
};

module.exports = config;
