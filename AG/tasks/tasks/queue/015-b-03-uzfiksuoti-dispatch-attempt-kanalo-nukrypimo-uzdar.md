# Task

## Spec source
openspec/changes/verqestra-backlog-v1/ (tasks.md eilutė: dispatch flow matavimas)

## Tikslas
Uždaryti `migration-coverage.json` įrašą apie dispatch attempt kanalo nukrypimą nuo etalono: attempt rezoliucija įvielinta, tad nukrypimas nebegalioja. CLAUDE.md reikalauja, kad nukrypimas ir jo uždarymas būtų fiksuojamas su priežastimi, o ne tyliai.

## Agentai
PRIVALOMA grandinė šia tvarka: readme-guard -> documenter -> reviewer. readme-guard eina pirmas ir grąžina ribų santrauką.

## Failai
Leidžiama:
- `migration-coverage.json`

Draudžiama:
- `src/**`
- `.env`
- `.env.*`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Surasti `migration-coverage.json` įrašą apie neįvielintą dispatch attempt kanalą (2026-08-25) ir pažymėti jį uždarytu su data bei priežastimi.
- Neliesti jokio kito įrašo ir nepridėti naujų nukrypimų.

## Patikra
- `pnpm test`

## Stop
Sustoti, kai `pnpm test` praeina. Tada commitinti ir sustoti. Sustoti nedelsiant, jei įrašo nerandama arba jo formatas neaiškus — tokiu atveju pranešti, o ne spėti.

## Neįtraukta
- Bet koks produkcinio kodo keitimas.
- Task 016 ir 017 darbai.
