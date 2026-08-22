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
