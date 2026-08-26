# Architektūros auditas ant kodo grafo — 2026-08-26

Pilnas `docs/architecture.md` auditas šaka po šakos, kur kiekvienas teiginys tikrinamas
**projekto paties kodo grafu** (`vq/state/code-index`, manifest v4.6.0, generuotas
2026-08-26T09:32Z: 1663 failai, 11048 simboliai, 37834 briaunos, iš jų 7622 importai
tarp skirtingų failų), o ne įspūdžiu. Analizės skriptas — `node --test` vienetas,
skaitantis `files.jsonl` + `edges.jsonl` ir skaičiuojantis sluoksnių matricą, paketų
izoliaciją, Tarjan SCC ciklus, fan-in/fan-out ir įeinančių importų neturinčius failus.

## Verdiktas

**Architektūra ir kodas sutampa.** 0 sluoksnių pažeidimų, 0 paketų izoliacijos
pažeidimų, 0 ciklų, 0 `node:` importų domain'e, visi 1765 testai žali. Rasta viena
doc'o nuorodos senatvė (pataisyta) ir viena struktūrinė pastaba (barrel'iai be
importuotojų) — abi žemiau.

## Šaka 1: Sluoksniai

Teiginys: `domain→domain,shared; application→application,domain,shared;
infrastructure→infrastructure,application,domain,shared;
interfaces→interfaces,application,domain,shared (NE infrastructure); composition→viskas`.

Grafo įrodymas — pilna importų matrica (iš→į, briaunų skaičius):

| iš \ į | shared | domain | application | infrastructure | interfaces | composition |
|---|---|---|---|---|---|---|
| shared | 14 | — | — | — | — | — |
| domain | 15 | 186 | — | — | — | — |
| application | 97 | 178 | 725 | — | — | — |
| infrastructure | 42 | 41 | 42 | 235 | — | — |
| interfaces | 23 | 51 | 187 | **0** | 273 | — |
| composition | 28 | 31 | 182 | 201 | 154 | 147 |
| entry (cli.ts) | — | — | — | — | — | 1 |

Kiekviena tuščia ląstelė yra 0 realiame grafe. `interfaces→infrastructure = 0` — doc'o
išskirtoji kryptis švari. `entry→composition = 1` — vienintelis cli.ts importas, teisingas.
**Pažeidimų: 0.**

## Šaka 2: Portai ir adapteriai

Teiginys: efektai per portus, `nodeFsAdapter` struktūriškai tenkina visus fs portus.

Grafo įrodymas: `infrastructure/fs/node-fs-adapter.ts` yra didžiausias fan-in hub'as
visame src (96 importuotojai) — visi iš `composition` ir `infrastructure` (matrica
aukščiau rodo, kad `interfaces` jo pasiekti negali). Struktūrinį tenkinimą įrodo žalias
`tsc` (satisfies — kompiliavimo faktas). **Atitinka.**

Hub'ų sveikata: fan-in viršūnės yra būtent tos, kurios ir turi būti bendros —
`node-fs-adapter` (96), `cli/registry` (78), `shared/json` (68), `run-process` (40),
`shared/paths` (37), `hooks/protocol` (34), `git-client` (33). Fan-out viršūnės —
composition surišėjai (`commands-ops` 45, `loop/command` 43, `dispatch-adapters` 30):
manual DI kaina gyvena ten, kur doc'as sako jai gyventi.

## Šaka 3: Vartai

Teiginys: sluoksnių/dydžio/higienos vartai bėga `pnpm test`.

Įrodymas: `src/tests/architecture-gates.test.ts` ir `src/tests/dead-export-gate.test.ts`
egzistuoja; pilnas paleidimas šiandien — **1765 testai, 0 kritusių**. Grafo ciklų
patikra (Tarjan SCC per visą src importų grafą, įskaitant type-only briaunas, nes
code-index jas mato): **0 ciklų**. **Atitinka.**

## Šaka 4: Paketai

Teiginys: benchmark varo CLI kaip procesą, šaltinių neimportuoja; ui-app ir mobile
izoliuoti.

Grafo įrodymas: iš 7622 importų briaunų **nė viena** neina `AG/benchmark→src`,
`ui-app→src`, `mobile-*→src`. Proceso ribą patvirtina
`AG/benchmark/src/application/ports/agent-process-port.ts` +
`infrastructure/adapters/node-agent-process-runner.ts` (spawn). Zonos grafe:
bench:src 185 failų, bench:fixtures 26, ui-app 141, mobile-gateway 172, mobile-app 94,
mobile-native 23 — visos uždaros. **Atitinka.**

## Šaka 5: Runtime keliai

Teiginys: `vq/*` runtime negyvena git'e, `templates/` yra šaltinis.

Įrodymas: `.gitignore:11` = `vq/`; `templates/` zona grafe — 21 failas. **Atitinka.**

## Šaka 6: Duomenų kelias

Teiginys: queue→preflight→context-pack→dispatch→quality-gates→Stop hook, „tyli baigtis
yra defektas".

Įrodymas: grandinės moduliai yra gyvi grafo mazgai su importuotojais (application
vidinių importų 725 — didžiausia matricos ląstelė), pilnas testų rinkinys žalias.
Elgesio lygio auditai atlikti atskirai šią savaitę (020/021/022 diagnozės
`docs/audits/`). **Atitinka.**

## Šaka 7: Ryšys su etalonu

Teiginys: 12 characterization rinkinių (166 atvejai).

Įrodymas: `src/tests/characterization-*.test.ts` — lygiai **12 failų**; apskaita
`E8-final-audit.md:16` — „166 atvejai / 12 rinkinių / 177 testai"; visi žali
šiandienos paleidime. **Atitinka.**

## Radiniai

1. **Doc'o senatvė (pataisyta):** `architecture.md:40` nurodė `composition/ui-server.ts`;
   tikrasis kelias — `composition/ui/server.ts`. Pataisyta šio audito metu.
2. **Pastaba (ne defektas):** visi 30 produkcinių src failų be įeinančių importų yra
   `index.ts` barrel'iai (11 application, 4 domain, 10 interfaces/cli, shared,
   infrastructure, composition, http, ui-model). Vidinis kodas importuoja konkrečius
   failus tiesiogiai — barrel'iai gyvena kaip deklaruoti sluoksnio kontraktai, bet be
   kvietėjų. `dead-export-gate` žalias, tad jie apskaityti; jokių kitų mirusių
   produkcinių modulių grafas nerado.

## Kas šio audito neapima

- Elgesio teisingumas (dengiamas characterization + unit testais, ne grafu).
- ui-app/mobile vidinė kokybė — grafas tikrino tik jų ribas su src.
- `vq/` runtime turinys — ne kodas.
