import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/tests/setup.ts"],
    // 2026-08-27: ReliabilityPage puslapio testas ramioje mašinoje renderina ~4.2s, o vartai
    // pagal dizainą bėga LYGIAGREČIAI su Claude dispatch'u — po apkrova numatytasis 5s
    // limitas virsdavo deterministiniu near-miss (raudoni vartai blokavo ir task'ą, ir stop).
    // Asercijos nekeistos; pakibęs testas vis tiek krenta, tik ties 15s.
    testTimeout: 15_000,
  },
});
