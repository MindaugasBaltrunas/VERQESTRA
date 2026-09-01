# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 130-evaluatepolicies-forbidden-deps-vertina-sasaja-ne-blanketa

## Žingsnis 0 — ar jau įgyvendinta?
Jei `migration-coverage.json` 2026-08-25 dispatch attempt kanalo įrašas
(`reason` laukas, dabar ~600 eil.) turi „PAPILDYTA 2026-08-30" anotaciją,
kuri (1) fiksuoja claude-last LOG kanalo įvielinimą su task id
(090-A-02/090-B-02/090-B-03) ir (2) AIŠKIAI palieka likutį atvirą
(„LIKUSI DALIS TEBEATVIRA: … decision, promote-execution-context,
promote-context-pack ir execution-result kanalai toliau eina per
veidrodžius") — ALREADY_IMPLEMENTED: cituok šią anotaciją kaip įrodymą.
2026-09-01 patikra: anotacija įraše YRA pažodžiui, su testais `tests` lauke —
tikėtina, kad šis task'as užsidaro čia.

## Tikslas
Ankstesnė šio task'o versija (2026-08-30 audito radinys) rėmėsi PASENUSIA
prielaida „attempt rezoliucija įvielinta, nukrypimas nebegalioja" ir liepė
įrašą UŽDARYTI — bet `migration-coverage.json` ~600 eil. įrašas pats
dokumentuoja, kad įvielintas TIK claude-last LOG kanalas (090 serija,
2026-08-30), o decision/promote-execution-context/promote-context-pack/
execution-result kanalai TEBEATVIRI (`DispatchAttemptView` —
`resolved.attempt` vis dar `undefined`). Uždarymas falsifikuotų apskaitą.
Tikroji šio task'o pareiga po korekcijos: užtikrinti, kad dalinis uždarymas
būtų užfiksuotas įraše su data ir aiškiu atviru likučiu — NE uždaryti visą
įrašą. Kadangi tokia anotacija įraše jau yra (žr. Žingsnis 0), realus
scenarijus — ALREADY_IMPLEMENTED su citata; Veiksmas žemiau taikomas tik
jei anotacijos dalis būtų dingusi ar iškraipyta.

## Agentai
readme-guard -> documenter -> reviewer

## Failai
Leidžiama:
- `migration-coverage.json`

Draudžiama:
- `src/**` (jokio produkcinio kodo — tai apskaitos task'as)
- `.env`
- `.env.*`
- `dist/**`
- `node_modules/**`

## Veiksmas
- TIK jei Žingsnio 0 sąlyga netenkinama: 2026-08-25 įrašo `reason` lauką
  papildyti daline uždarymo anotacija — data, claude-last LOG kanalo
  įvielinimo faktas su 090 serijos task id, ir EKSPLICITINIS atviras
  likutis (decision/promote/execution-result kanalai per veidrodžius).
  Įrašo NEUŽDARYTI ir „nebegalioja" NERAŠYTI, kol visi kanalai neįvielinti.
- Neliesti jokio kito įrašo ir nepridėti naujų nukrypimų.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios (ALREADY_IMPLEMENTED atveju — ataskaita su
citata be commit'o, pagal markerio konvenciją). Stop ir pranešk, jei įrašo
formatas neatpažįstamas arba jame atsirado prieštaraujančių anotacijų —
spėti draudžiama.

## Neįtraukta
- Likusių kanalų (decision, promote-execution-context, promote-context-pack,
  execution-result) ĮVIELINIMAS — src darbas, atskiras task'as; šis task'as
  tik saugo apskaitos teisingumą.
- Pilnas įrašo uždarymas — draudžiamas, kol likutis atviras.
- Sankirta su 130: abu task'ai rašo `migration-coverage.json` (130 prideda
  NAUJĄ nukrypimo įrašą) — todėl deklaruota priklausomybė; šis task'as bėga
  po 130 ir jo įrašo neliečia.
