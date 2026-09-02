# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 138-agentu-grandines-parseris-nebedaro-cipu-is-prozos-zodziu

## Žingsnis 0 — ar jau įgyvendinta?
Jei apžvalgos gyvos veiklos šaltinis worktree dispatch'o metu yra AKTYVUS
srautas (tėvo attempt kanalas, gyvai TEE'inamas, ARBA per gyvą lease
išsekvotas worktree kopijos log'as), o nesant gyvo šaltinio UI gauna TUŠČIĄ
veiklą (ne seno veidrodžio turinį) — ALREADY_IMPLEMENTED: cituok šaltinio
rezoliucijos kodą, fail-safe šaką ir testus kaip įrodymą.

## Tikslas
Gyvas įrodymas (2026-09-01 18:0x): Apžvalgos „Aktyvus vykdymas" gyva komanda
ir agentų čipai ateina iš pagrindinio medžio `vq/logs/claude-last.log`,
kurio mtime 10:32 — 8 valandų FOSILIJA iš paskutinio ne-worktree dispatch'o,
o gyvi worktree worker'iai (run `ec04af19`, worktree failai gyvi 17:58) rašo
į SAVO kopijos `vq/logs/claude-last.log`, kurio UI nemato. Mechanizmas
patikrintas: (1) UI kelio šaltinis — `composition/ui/sse-adapters.ts:96-124`
`resolveActiveAttempt` TĖVO runtimeRoot'e; worktree dispatch'o attempt
namespace kuriamas VAIKO runtimeRoot'e (worktree `vq`), tad tėvo rezoliucija
grąžina „bandymo kopijos dar nėra" ir watch krenta į legacy veidrodį
(128-133 eil.) — fosiliją; skaitytojo default tas pats
(`interfaces/ui-model/agent-activity-reader.ts:45`), dashboard stamp — irgi
(`composition/ui/dashboard-adapters.ts:171`). (2) Tėvo attempt kelias
(`vq/runtime/runs/<run>/workers/<w>/tasks/<task>/attempts/a1/logs/
claude-last.log`) užpildomas KOPIJA dispatch'ui BAIGUS (resume.log faktas)
— ne gyvai; 090 serija įvielino kelio REZOLIUCIJĄ, ne gyvą tėvo srautą.
Tai trečias worktree matomumo šeimos narys (po bucket būsenos [137] ir
verdikto propagacijos [135]). Kryptys architect sprendimui: (a) dispatch
srautas TEE'inamas į tėvo attempt kelią GYVAI, UI skaito iš aktyvaus
attempt; (b) tėvo UI skaitytojas sekvoja per gyvus lease'us (lease neša
`worktree_path`) į worktree kopijos log'ą — paprasčiau, bet skaitoma iš
išmetamo katalogo (gyvam vaizdui su fail-safe tai leistina). FAIL-SAFE
PRIVALOMAS abiem šakoms: nesant gyvo šaltinio, veikla grąžinama TUŠČIA —
UI jau turi sąžiningus tuščios būsenos kelius („Waiting for a task…",
„Stream unknown"); pasenusio turinio rodymas be žymos yra ŠIO incidento
esmė, todėl legacy veidrodis gyvo vykdymo kontekste nebenaudojamas kaip
turinio šaltinis. DIZAINO RIBA: sprendimas serverio pusėje, be naujų UI
tekstų — jei paaiškėtų, kad be jų neapsieinama, Stop (UI hotspot grandinė).

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/composition/ui/sse-adapters.ts`
- `src/composition/ui/dashboard-adapters.ts`
- `src/interfaces/ui-model/agent-activity-reader.ts`
- `src/interfaces/http/sse-service.ts` (tik jei watch sąrašo forma keičiasi)
- `src/infrastructure/adapters/claude-last-log.ts` (tik (a) šaka — gyvas
  TEE į tėvo attempt kelią)
- `src/composition/agent/dispatch-adapters.ts` (tik (a) šaka — tėvo kelio
  perdavimas rašytojui)
- `src/tests/composition-ui-sse-live-updates.test.ts`
- `src/tests/interfaces-ui-model-agent-activity.test.ts` (deklaruotas ir
  138 — todėl priklausomybė)

Draudžiama:
- `ui-app/**` (sprendimas serverio pusėje; nauji UI tekstai = Stop)
- `src/interfaces/ui-model/agent-activity.ts` (grynos projekcijos logika —
  138 scope ribojasi; čia keičiasi tik ŠALTINIO parinkimas reader'yje)
- `src/application/scheduling/worker-lease-store.ts` (lease kontraktas
  nekinta — (b) šaka tik skaito `worktree_path`)
- `dist/**`
- `node_modules/**`

## Veiksmas
- ŽINGSNIS 1 (architect): (a) ar (b) su pagrindimu. Svarstyti: (a) tėvo
  attempt store tampa gyvu tiesos šaltiniu visiems skaitytojams (diagnozė,
  UI, write-activity) — bet vaikas turi žinoti tėvo runtime kelią ir rašyti
  per procesų ribą; (b) izoliuotas UI pakeitimas be dispatch kelio rizikos
  — bet šaltinis išnyksta su worktree valymu (fail-safe tą dengia).
- Įgyvendinti pasirinktą šaką: šaltinio rezoliucija „aktyvus worktree
  dispatch" atvejui (gyvas lease su worktree_path → to attempt/log kelias)
  ir SSE watch failų sąrašo atnaujinimas tuo pačiu keliu.
- Fail-safe: legacy veidrodis (`vq/logs/claude-last.log`) gyvo vykdymo
  kontekste nebeteikiamas kaip veiklos turinys; kai gyvo šaltinio nėra —
  tuščia veikla (esami UI tušti keliai), o veidrodžio naudojimas leidžiamas
  TIK kontekstuose, kurie jį aiškiai žymi (pvz. sse `stopStatusSource:
  "legacy"` semantika — jos žymėjimo prasmė išlaikoma).
- Testų lūkestis: (1) regresija — gyvas lease su worktree_path + šviežias
  worktree log'as → veikla iš worktree srauto (ar tėvo TEE), ne iš
  veidrodžio; (2) fosilijos atvejis — veidrodis senas, gyvo šaltinio nėra →
  tuščia veikla, veidrodžio turinys NErodomas; (3) ne-worktree dispatch'o
  esamas elgesys (attempt kanalas tėvo runtime) žalias; (4) worktree
  išvalytas mid-read → tuščia veikla be klaidos (fail-safe, ne crash).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei: (1) sąžiningam
pateikimui prireiktų NAUJŲ UI tekstų (ui-app hotspot grandinė — atskiras
task'as su priklausomybe nuo 137); (2) (a) šakai paaiškėtų, kad vaikas
neturi patikimo kanalo tėvo runtime keliui gauti be dispatch kontrakto
keitimo.

## Neįtraukta
- Bucket būsenos matomumas apžvalgoje/lentoje — 137.
- Verdikto propagacija į tėvo bucket'us — 135.
- Pasibaigusio dispatch'o log kopijos į tėvo attempt store mechanizmas —
  veikia, neliečiamas; čia sprendžiamas tik GYVO srauto matomumas.
- `vq/logs/claude-last.log` veidrodžio rašymo pusė
  (`claude-launcher.ts:18` best-effort semantika) — rašytojas lieka;
  keičiasi tik skaitytojų pasitikėjimas juo gyvame kontekste.
