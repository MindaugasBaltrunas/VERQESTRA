// interfaces/cli/benchmark barrel — re-exports only (MOD-1).
// E5 VQ-501 (4/5-c): benchmark klasteris — benchmark-package (tiltas į atskirą AG/benchmark
// workspace paketą per įkėlimo portą; ag-loop invocation šablonas iš nodeExecPath/cliEntry),
// benchmark-drive (ribotas vienos celės ciklas su ag-loop/2 telemetrijos envelope) ir
// optimization-benchmark (plonas sluoksnis virš VQ-305 application/benchmark).
export * from "./benchmark-package.js";
export * from "./benchmark-drive.js";
export * from "./optimization-benchmark.js";
