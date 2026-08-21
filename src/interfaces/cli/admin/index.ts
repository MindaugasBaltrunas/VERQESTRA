// interfaces/cli/admin barrel — re-exports only (MOD-1).
// E5 VQ-501 (5/5-b): valdymo/peržiūros komandos — policy (registro ribotas proposal
// lifecycle), agent (registras + persona keičiami kartu, numatytasis vaidmuo apsaugotas) ir
// status (tik skaitantis operatoriaus paviršius, atsparus sugadintiems būsenos failams).
export * from "./policy.js";
export * from "./agent.js";
export * from "./status.js";
