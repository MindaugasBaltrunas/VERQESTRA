# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Priklausomybės
- 077-a (parseris jau tolerantiškas pertekliniams laukams ir tipe lieka tik `enabled`)

## Tikslas
Suderinti konfigo failus su išvalytu `WorktreePolicy` kontraktu: template'e ir gyvame runtime konfige lieka TIK `enabled`. Melagingi `root`/`branchPrefix`/`pathPrefix` laukai klaidina operatorių apie tai, ką jis valdo.

## Agentai
PRIVALOMA grandinė (ta pati eilės tvarka, be praleidimų): `readme-guard -> architect -> coder -> reviewer -> tester`.

## Failai
Leidžiama:
- `templates/vq/config/worktree-policy.json`
- `vq/config/worktree-policy.json`

Draudžiama:
- `vq/config/worktree-policy.json` lauko `enabled` REIKŠMĖS keitimas (operatoriaus sprendimas, ne cleanup)
- `src/application/scheduling/worktree-policy.ts`
- `src/tests/git-rules.test.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: patvirtinti, kad abu failai naudojami tik per `loadWorktreePolicy`, ir kad template versijos kėlimo taisyklė šiam pakeitimui netaikoma (arba taikoma — įrašyti verdiktą į ataskaitą).
- Coder: abiejuose failuose palikti tik `enabled` lauką su nepakeista reikšme; LF, be BOM.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Stop ir klausk, jei koks nors testas ar produkcinis kelias reikalauja pašalintų laukų, arba jei template versijos kėlimas atrodo būtinas.

## Neįtraukta
`enabled` reikšmės perjungimas. Bet koks `src/**` pakeitimas.
