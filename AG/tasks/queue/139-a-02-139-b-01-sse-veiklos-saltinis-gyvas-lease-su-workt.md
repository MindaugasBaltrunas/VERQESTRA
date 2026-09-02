# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
Apžvalgos „Aktyvus vykdymas" SSE kelias worktree dispatch'o metu rodo fosiliją: `resolveActiveAttempt` ieško bandymo TĖVO runtimeRoot'e, o worktree dispatch'o attempt namespace gyvena VAIKO `vq` medyje, tad rezoliucija nepavyksta ir watch krenta į legacy veidrodį (`src/composition/ui/sse-adapters.ts:96-133`). Reikia, kad gyvo worker lease atveju (lease neša `worktree_path`) šaltinis būtų to worktree bandymo `logs/claude-last.log`, o watch failų sąrašas rodytų tą patį kelią. Priklausomybė: 139-a-01 (skaitytojo gyvo konteksto semantika) turi būti baigtas — čia ji tik įjungiama.

## Agentai
Privaloma grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `src/composition/ui/sse-adapters.ts`
- `src/tests/composition-ui-sse-live-updates.test.ts`

Draudžiama:
- `src/interfaces/ui-model/agent-activity-reader.ts`
- `src/composition/ui/dashboard-adapters.ts`
- `src/interfaces/http/sse-service.ts`
- `src/application/scheduling/worker-lease-store.ts`
- `ui-app/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Papildyk aktyvaus šaltinio rezoliuciją: gyvas lease su `worktree_path` → to worktree bandymo `logs/claude-last.log`; lease kontraktas nekeičiamas, tik skaitomas.
- Gyvo vykdymo kontekste nebeteik legacy veidrodžio kaip veiklos turinio — perduok skaitytojui gyvo konteksto žymę, kad nesant šaltinio grąžintų tuščią veiklą; watch sąrašas seka tą patį kelią.
- Testai: gyvas worktree lease → turinys iš worktree srauto; senas veidrodis be gyvo šaltinio → tuščia; ne-worktree dispatch (tėvo attempt) → žalias; worktree dingsta mid-read → tuščia be klaidos.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei: (1) reikėtų keisti `sse-service.ts` watch sąrašo formą; (2) architect nuspręstų, kad teisingas sprendimas yra gyvas TEE į tėvo attempt kelią — tai kitas scope.

## Neįtraukta
- Dashboard stamp'o šaltinis — 139-c-01.
- Gyvas TEE į tėvo attempt (`claude-last-log.ts`, `dispatch-adapters.ts`).
- Bucket būsenos matomumas (137) ir verdikto propagacija (135).
