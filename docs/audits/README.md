# Auditų katalogas

Šiame kataloge gyvena epikų audito ataskaitos. Kiekviena rašoma po to, kai epikas
uždaromas, ir yra to epiko **verdiktas**: skaičiai (failai, eilutės, testai), radiniai,
kas atidengta prijungus komponentus vienas prie kito, ir rizikos, keliaujančios į kitus
epikus.

## Kodėl `docs/`, o ne `vq/`

`vq/` yra šio produkto runtime būsena — ji negyvena git'e. Auditas yra priešingybė:
tai įrodymas, kurį privaloma commit'inti, kad jis liktų prieinamas ir po to, kai runtime
būsena pasikeis ar bus išvalyta.

## Failai

| Failas | Epikas | Data |
|---|---|---|
| [E6-audit.md](E6-audit.md) | E6 — UI app + benchmark paketas | 2026-08-22 |
| [E7-audit.md](E7-audit.md) | E7 — Self-hosting | 2026-08-22 |
| [E8-parity.md](E8-parity.md) | E8 — pilnas parity bėgimas (VQ-801) | 2026-08-22 |
| [E8-benchmark-audit.md](E8-benchmark-audit.md) | E8 — benchmark auditas prieš mokamą bėgimą (VQ-802) | 2026-08-22 |
| [E8-final-audit.md](E8-final-audit.md) | E8 — galutinis auditas ir cutover (VQ-80A) | 2026-08-22 |
| [ui-app-runtime-audit-2026-08-23.md](ui-app-runtime-audit-2026-08-23.md) | Operator UI paleidimas — 3 × P0, visi uždaryti tą pačią dieną | 2026-08-23 |

Paskutinis įrašas nėra epiko verdiktas, o PALEIDIMO auditas: jis rašomas tada, kai produktas
tikrinamas taip, kaip jį paleidžia operatorius. Toks auditas pagavo tai, ko 1473 + 393 žali
testai nepagavo — kad `/api/dashboard` grąžina visai kitą dokumentą, nei laukia klientas.
