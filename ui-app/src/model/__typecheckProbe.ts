// SCRATCH — TRINTINAS. Šis failas buvo laikina patikra, ar `pnpm --dir AG/orchestrator/ui-app
// typecheck` apskritai tikrina `src` (neprisiima: `tsconfig.json` turi `files: []` + `references`,
// tad `tsc --noEmit` be `-b` nepatikrina nieko). Patikra atsakė „ne" — realus tikrinimas yra
// `tsc -b AG/orchestrator/ui-app`.
//
// Failo ištrinti negaliu: bash policy neleidžia nė vienos trynimo komandos (`rm`, `find -delete`,
// `git clean`). Prašau ištrinti rankiniu būdu — jokio kodo jame nėra ir niekas jo neimportuoja.
export {};
