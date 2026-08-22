# Spec workflow

Kelias yra vienakryptis: **spec → planas → eilės užduotys → vykdymas → suderinimas**. Kiekviena
pakopa turi savo vartą, ir nė viena jų neišveda to, ko ankstesnė nepasakė.

## 1. Spec change

Du atskiri dalykai, sąmoningai neapjungti:

| Vieta | Auditorija | Ką neša |
|---|---|---|
| `AG/openspec/changes/<id>/` | žmogus | `proposal.md`, `design.md`, `spec.md`, `tasks.md` |
| `AG/spec/changes/<id>/spec.json` | mašina | `id`, `status`, `scope` (glob'ai) |

Sulieti juos reikštų, kad scope vartas priklausytų nuo laisvo teksto formatavimo.

## 2. Planas

```bash
node dist/cli.js plan [--force]
```

Iš aktyvios specifikacijos gaminamas architektūros kontraktas. `--force` perrašo esamą planą;
be jo esamas planas yra autoritetas, nes pagal jį jau gali būti sugeneruotų užduočių.

## 3. Užduočių generavimas

```bash
node dist/cli.js task-generate --change <id> [--start <n>]
node dist/cli.js converge         # ar planas ir eilė vis dar sutampa
node dist/cli.js backlog-audit    # dublikatai, superseded, tuščios užduotys
```

`converge` yra vartas, o ne ataskaita: plano ir eilės išsiskyrimas reiškia, kad kažkas
redagavo vieną pusę rankomis, ir tolesnis vykdymas remtųsi negaliojančiu kontraktu.

## 4. Vykdymas

```bash
node dist/cli.js preflight <task-file>    # dydis, spec šaltiniai, biudžetas, agentai
node dist/cli.js loop                     # eilė → dispatch → vartai → commit
```

`preflight` gali pasakyti `human-review` — tai nėra klaida. Tai riba, ties kuria užduotis yra
per plati arba per neapibrėžta, kad ją būtų sąžininga paduoti agentui.

## 5. Suderinimas su spec

```bash
node dist/cli.js spec-drift <change-id>
node dist/cli.js milestone-check
node dist/cli.js openspec-reconcile [--apply]
```

`spec-drift` lygina pakeistus failus su `scope`. Failas UŽ ribų nėra automatiškai blogas — bet
jis privalo būti MATOMAS, o ne tylus. `milestone-check` sudeda tris atsakymus (kokybė, spec
derėjimas, saugumo politika) į vieną verdiktą; nesant aktyvaus change'o spec dalis rodo
`skipped`, o ne `ok` — nežinojimas nėra sėkmė.

## Būsenos, kurias verta žinoti

| Būsena | Ką reiškia |
|---|---|
| `human-review` | vartas atsisakė spręsti už žmogų; darbas laukia sprendimo |
| `skipped` | patikra netaikoma (nėra scope) — NE tas pats kaip `ok` |
| `blocked` | saugumo politika rado tikrą radinį |
| `stale` | artefaktas yra, bet jis senesnis už tai, ką aprašo |
