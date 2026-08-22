# Design: AG Loop benchmark v1

## Komponentai

```text
interfaces/cli + interfaces/http
             ↓
application/{validate,run,verify,compare,report}
             ↓
domain/{scenario,result,metrics,baseline,verdict}
             ↑
infrastructure/{fixture-store,worktree,agent-adapters,jsonl,environment}
```

## Workspace

`AG/benchmark` yra atskiras pnpm workspace paketas. Domain lieka be FS, Git, process, HTTP ir React priklausomybių. Application priklauso nuo portų. Infrastructure įgyvendina Git worktree, procesų, failų ir agentų adapterius. AG orchestratoriaus CLI ir HTTP sluoksniai kviečia tik benchmark public application API.

## Duomenų srautas

1. `validate` užkrauna suite ir apskaičiuoja canonical hash.
2. Runneris kiekvienam `scenario × mode × repetition` sukuria izoliuotą worktree.
3. Adapteris vykdo agentą su vienodais inputais ir limitais.
4. Verifieris nepriklausomai paleidžia checks ir klasifikuoja scope.
5. JSONL store atomiškai įrašo schema-validų sample.
6. Aggregatorius apskaičiuoja metrikas; comparatorius tikrina suderinamumą ir slenksčius.
7. Reporter generuoja JSON/Markdown; HTTP pateikia jau apskaičiuotą rezultatą UI.

## Saugumas

- Fixture negali rodyti už benchmark workspace ribų.
- Worktree šaknis privalo būti išspręsta ir patikrinta prieš create/cleanup.
- Network/model benchmarkas leidžiamas tik explicit režimu.
- Tokenai, promptų paslaptys ir credentials nerašomi į reportus.
- Cleanup nenaudoja force prieš nepatikrintą kelią.

## Palyginamumas

Canonical config hash apima suite versiją, scenarijus, modelio parametrus, limitus, verifier checks ir režimų adapterių versijas. Aplinkos skirtumai pateikiami atskirai; privalomų laukų neatitikimas duoda `inconclusive`.

## Priklausomybių tvarka

`0002 → 0003 → 0004 → 0005 → 0006 → 0007 → 0008 → 0009 → 0010 → 0011 → 0012 → 0013 → 0014 → 0015 → 0016 → 0017`.

Ši nuosekli pirmoji versija sąmoningai neleidžia benchmarko implementacijai konfliktuoti tarpusavyje. Paralelus scenarijų vykdymas gali būti įjungtas tik po izoliacijos įrodymo.
