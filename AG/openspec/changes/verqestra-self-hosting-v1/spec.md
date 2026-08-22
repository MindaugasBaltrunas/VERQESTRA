# Spec: VERQESTRA self-hosting v1

## SH-1 — Eilė yra vienintelis darbo įėjimas

Užduotis vykdoma TIK iš `AG/tasks/queue`. Rankinis agento paleidimas be task'o failo nėra
palaikomas kelias: be užduoties nėra nei leidžiamų kelių, nei patikrų, nei stop sąlygos.

## SH-2 — Spec kontekstas privalomas

`claude-preflight` reikalauja OpenSpec konteksto (`AG/openspec/project.md` arba task'e
nurodyto change'o). Jo nesant užduotis keliauja į `human-review`, o NE į dispatch'ą.
Spec-first orkestratorius, vykdantis užduotį be spec'o, prieštarauja savo paties apibrėžimui.

## SH-3 — Leidžiami keliai yra kieta riba

Agentas gali kurti ir keisti tik `## Failai / Leidžiama` išvardytus kelius. Riba renderinama
į execution context pilna, be karpymo.

## SH-4 — Vartai prieš commit'ą

Stop hook'as commit'ina TIK tada, kai kokybės vartai žali ir visi taikomi guard'ai praėjo.
Nepaleistas guard'as NIEKADA nelaikomas praėjusiu.

## SH-5 — Push yra atskiras sprendimas

`auto_push_enabled` valdo push'ą nepriklausomai nuo `auto_commit_enabled`. Nepavykęs push'as
NEATŠAUKIA commit'o ir nekelia klaidos: darbas lieka lokalioje istorijoje.

## SH-6 — Kiekviena baigtis palieka įrodymą

Kiekvienas terminalinis kelias rašo stop-bridge įrašą su statusu ir priežastimi. Tyli baigtis
yra defektas, net jei ji sėkminga.
