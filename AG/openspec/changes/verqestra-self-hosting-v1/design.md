# Design: VERQESTRA self-hosting v1

## Kelias, kurį įrodinėjame

```text
AG/tasks/queue/<task>.md
  → preflight          (dydis, spec šaltiniai, biudžetas, agentai)
  → claude-preflight   (OpenSpec kontekstas; be jo — human-review)
  → context-pack       (užduotis + spec fragmentai + kodo grafas, vienas biudžetas)
  → dispatch           (claude -p headless; leidžiami keliai yra kieta riba)
  → quality-gates      (vq/config/quality-policy.json komandos)
  → Stop hook          (secret-scan → package-guard → migration-guard → commit)
```

Kiekviena rodyklė turi savo gedimo kelią, ir nė vienas jų nėra tylus: preflight rašo
`human-review` priežastį, dispatch — diagnozę, vartai — `vq/state/*-result.json`, Stop hook —
`vq/logs/hooks.log` eilutę ir stop-bridge įrašą.

## Sprendimai

**Hook'ai kviečiami absoliučiu keliu**, ne `verqestra` binaru: PATH yra aplinkos savybė, o
`$CLAUDE_PROJECT_DIR/dist/cli.js` yra šio medžio savybė. Diegiamas šablonas naudoja binaro
formą — ten paketas yra įdiegtas, ir tai teisinga forma svetimam projektui.

**Auto-push išjungtas šiame repo, bet ne šablone.** Commit'as lokalus ir atšaukiamas; push yra
išorinis veiksmas. Numatytoji produkto elgsena lieka nepakeista — pakeista tik ŠIO diegimo
politika, ir būtent tam politikos failas egzistuoja.

**Pirmas gyvas task'as yra dokumentacinis.** Ne dėl baimės, o dėl matavimo: jei ciklas lūžta,
priežastis turi būti cikle, ne užduoties sudėtingume.

## Kas laikoma įrodymu

Ne „komanda pasileido", o: task'o failas nukeliavo iš `queue` į `done`, git istorijoje yra
commit'as su conventional žinute, `vq/state/quality-gates-status.json` žalias, o
`vq/logs/hooks.log` turi visą grandinę.
