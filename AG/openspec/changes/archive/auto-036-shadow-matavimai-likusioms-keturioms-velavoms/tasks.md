# Tasks

- [x] readme-guard: patvirtinti ribas `src/application/context-pack/**`, `src/interfaces/hooks/**`, `src/interfaces/http/ui-compression-view.ts`, `ui-app/src/**` (tik verdikto laukai/vertimai), `src/tests/**`.
- [x] architect: apsispręsti dėl tikslių naujų lauko pavadinimų (dispatch_tool_schema ir compact_dsl poroms) `metrics.ts` `COMPRESSION_METRIC_FIELDS` lentelėje; patikrinti FAKTĄ, ar `task_id` pasiekiamas PostToolUse Bash hook kontekste `bash_output_digest` porai; suprojektuoti `FEATURE_PAIR_SELECTORS` apibendrinimą `ui-compression-view.ts`, išlaikant `worker_task_ir` verdikto bitinį tapatumą.
- [x] schedule-domain: `symbol_slices` skaičiavimo perkėlimas `gather.ts`/`tiers.ts` iš "po tier sprendimo" į "visada surinkimo metu"; `compact_dsl` poros pratekinimas iš `compact-dsl/render.ts`.
- [x] coder: `bash_output_digest` rašytojas `post-hooks.ts`; `dispatch_tool_schema` shadow matavimas dispatch paruošimo taške; `decideCompression`/`summarizeContextSizeSamples` apibendrinimas `ui-compression-view.ts`; `ui-app` vertimai naujiems `reason`/vėliavos kombinacijoms.
- [x] reviewer: patikrinti, kad nė vienas naujas matavimo taškas nekeičia realiai perduodamo turinio (Bash output, worker prompt, dispatch schema, DSL dokumentas) ir kad visi nauji laukai eina per vieną `COMPRESSION_METRIC_FIELDS` lentelę.
- [x] tester: regresijos testas `worker_task_ir` verdikto bitiniam tapatumui; nauji testai kiekvienai iš keturių vėliavų (rašytojas rašo teisingą porą; `decideCompression` grąžina teisingą verdiktą su pora ir `"unmeasured"` be jos); `pnpm typecheck && pnpm test && pnpm --dir ui-app test` žali.
- [x] Commit'inti tik kai visos patikros žalios (žr. CLAUDE.md "Patikros" ir šio task'o "## Stop" sąlygas).

## AG Queue Tasks
- Šaltinio užduotis: `AG/tasks/queue/036-shadow-matavimai-likusioms-keturioms-velavoms.md` (depends_on: `032-shadow-matuoja-prompta-kuri-worker-realiai-gauna.md`, jau `AG/tasks/done/`).
- Agentų grandinė: `readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester` (kaip nurodyta task faile).
- Jei implementacijos metu paaiškėja, kad `task_id` nepasiekiamas PostToolUse Bash hook kontekste be papildomo porto, tai atskira sub-užduotis (naujas AG task), ne šio task'o dalis — eskaluoti orchestratoriui, nespręsti tyliai apeinant.
- UI vertimų darbas (`ui-app/src/**`) apribotas TIK verdikto laukais/vertimais — jokio kito UI komponento pakeitimo šioje užduotyje.
