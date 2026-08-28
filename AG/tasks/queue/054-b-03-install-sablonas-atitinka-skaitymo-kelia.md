# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Tikslas
Isitikinti, kad `verqestra install` deda worktree politika tiksliai i ta kataloga, is kurio ja dabar skaito loop'as (`vq/config/`), ir kad sablono turinys yra galiojantis politikos dokumentas su aiskiu default.

## Agentai
Privaloma grandine: readme-guard -> reviewer.

## Failai
Leidziama:
- `templates/vq/config/worktree-policy.json`

Draudziama:
- `src/**`
- `dist/**`

## Veiksmas
- Perskaityti `templates/vq/config/worktree-policy.json` ir palyginti laukus su `src/application/scheduling/worktree-policy.ts` parserio schema.
- Jei sablono laukai ar default `enabled` neatitinka parserio — suderinti sablona (parseris neliecamas).
- Jei viskas sutampa, palikti be pakeitimu ir tai irasyti ataskaitoje.

## Patikra
- `pnpm test`

## Stop
Commit'ink tik jei sablonas keistas ir patikra zalia. Sustok, jei paaiskeja, kad reikia keisti parseri arba install kodo kelius.

## Neitraukta
Kitu politiku sablonai. Install komandos kodas.
