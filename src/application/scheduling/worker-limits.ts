// Workerių kiekio KIETOS lubos — vienas apibrėžimas visai sistemai (spec WRK-3, design §13):
// wave scheduler'is, worker pool'as ir E4 runtime namespace (worker id formatas) privalo
// dalintis TUO PAČIU skaičiumi, kitaip du „2" prasilenktų. Behaviour etalon: AG_loop
// application/runtime/runtime-paths.ts RUNTIME_MAX_WORKERS (konstanta atkeliauja anksčiau
// už E4 runtime kelius, nes ją vartoja E3 scheduling).

/** Hard ceiling on worker ids. The wave scheduler runs one worker today; a second is gated. */
export const RUNTIME_MAX_WORKERS = 2;
