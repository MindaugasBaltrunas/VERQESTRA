# Task

## Spec source
docs/audits/ (kompresoriaus auditas 2026-08-26)
src/application/context-pack/worker-task-ir.ts (NO SILENT LOSS taisyklė)

## Tikslas
WorkerTaskIR viduje turinys neturi būti nešamas dvigubai. Auditas 2026-08-26 (53 realūs
task failai): vien string turinio IR viduje vidutiniškai 2 393 ženklai, kai visas raw
failas — 2 186. Priežastis: atpažinta sekcija, kurios struktūrinis parse'as nepadengia
kiekvienos eilutės, nešama IR struktūriškai, IR verbatim `elements` bloke — o realių
task failų šablonui tai suveikia praktiškai visada.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/worker-task-ir.ts`
- `src/application/context-pack/worker-task-ir-schema.ts`
- `src/application/context-pack/compact-dsl/**`
- `src/tests/**`

Draudžiama:
- `AG/**` (etalonas read-only)
- `vq/**`
- `.env`

## Dependencies
depends_on: none

## Veiksmas
- FAKTAS: `worker-task-ir.ts:18-22` — „a recognized section whose structured parse did not
  account for every line ALSO keeps its full body as a verbatim element". Išmatuota, kad
  ant realių failų tai duoda ~+9% vien turinio dubliavimo (2 393 vs 2 186 vid.).
- Diagnozuoti, KURIOS eilutės realiuose task failuose lieka „neapskaitytos" (tikėtina:
  sąrašo punktų tęsiniai per kelias eilutes, tuščios eilutės, `Leidžiama:`/`Draudžiama:`
  antraštės Failai sekcijoje) ir išplėsti struktūrinį parse'ą taip, kad standartinis
  task šablonas būtų padengtas pilnai — verbatim fallback'as liktų TIK tikrai
  neatpažintam turiniui.
- NO SILENT LOSS nesilpninamas: kiekviena eilutė privalo būti įrodomai arba struktūroje,
  arba verbatim bloke — niekada niekur. Lossless atstatymo įrodymas (DSL decode atgal į
  tą patį IR) lieka.
- Sėkmės kriterijus matuojamas: ant `AG/tasks/queue` + `done` korpuso IR JSON vidurkis
  tampa MAŽESNIS už raw vidurkį arba bent turinio dubliavimas krenta iki <2%. Skaičius
  fiksuojamas teste, ne teiginyje.
- IR schema versijuojama: jei keičiasi `WorkerTaskIr` laukų prasmė — kelti IR versiją ir
  atnaujinti prompt'o skaitymo raktą.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei aprėpties neįmanoma pasiekti nesilpninant
fail-closed taisyklių (trūkstamas goal/paths/checks = klaida) — tada grąžink radinį
operatoriui su konkrečiais neapskaitytų eilučių pavyzdžiais.

## Neįtraukta
- Prompt'o lygio dedup (task 029).
- Preambulės mažinimas (task 031).
- Matavimo poros keitimas (task 032).
