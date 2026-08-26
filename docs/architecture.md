# Architektūra

Šis dokumentas aprašo, kaip VERQESTRA sudėtas ir — svarbiau — **kodėl būtent taip**. Ribos čia
nėra stiliaus klausimas: jas tikrina `src/tests/architecture-gates.test.ts`, ir jos yra
fail-closed nuo pirmo commit'o, be jokio baseline.

## Sluoksniai

```text
shared          primityvai: result, errors, ids, json, markdown, hash, paths
  ↑
domain          GRYNOS taisyklės — jokio failų sistemos, proceso ar laikrodžio
  ↑
application     use-case'ai + PORTAI; IO tik per įleistus portus
  ↑
infrastructure  adapteriai, realizuojantys application portus
  ↑
interfaces      pristatymas: cli, hooks, http, ui-model
  ↑
composition     rankinis DI; niekas neimportuoja composition
```

Leidžiamos kryptys:

| Sluoksnis | Gali importuoti |
|---|---|
| `domain` | `domain`, `shared` |
| `application` | `application`, `domain`, `shared` |
| `infrastructure` | `infrastructure`, `application`, `domain`, `shared` |
| `interfaces` | `interfaces`, `application`, `domain`, `shared` — **NE** `infrastructure` |
| `composition` | viskas |

### Kodėl `interfaces` nemato `infrastructure`

Tai vienintelė kryptis, kurią lengviausia pažeisti ir sunkiausia pastebėti. CLI handleriui
„tiesiog reikia" perskaityti failą — ir po vieno tokio importo handleris nebeturi ribos: jis
nebegali būti ištestuotas be disko, o jo elgesys nebeaprašomas portu. Todėl efektai ateina per
portus, o surišimas gyvena `composition`.

Praktinė pasekmė matoma `composition/ui/server.ts`: HTTP kiautas yra KOMPOZICIJA, ne
infrastructure, nes jis jungia GRYNĄ `interfaces/http/ui-router` su `node:http`. Pirmas
bandymas dėti jį į `infrastructure/http` krito ties vartu — teisingai.

### Kodėl `domain` neturi nė vieno `node:` importo

Net `node:path`. Kelio semantika yra platformos savybė, o domeno taisyklė — ne. Vienas
`node:path` importas domene reikštų, kad taisyklė elgiasi skirtingai Windows ir Linux, ir kad
jos negalima paleisti ten, kur nėra failų sistemos.

## Portai ir adapteriai

Portas deklaruojamas ten, kur jo REIKIA (`application`), o ne ten, kur jis realizuojamas.
Kryptis yra visa esmė: `application` sako, ko jam reikia, o `infrastructure` tai tenkina.

Vienas Node FS adapteris (`infrastructure/fs/node-fs-adapter`) tenkina VISUS klasterių fs
portus struktūriškai — be wrapper'ių. Tai ne sutaupymas, o įrodymas: jei portas ir adapteris
prasilenktų, `tsc` kristų dar prieš bet kokį runtime testą.

## Vartai

| Vartas | Taisyklė |
|---|---|
| file-length | kiekvienas `src` failas ≤ 500 eilučių, JOKIO baseline |
| boundary | sluoksnių importų kryptis, nulis išimčių |
| classification | kiekvienas `src/**` failas priklauso žinomam sluoksniui/rolei |
| cycles | importų grafas aciklinis, įskaitant type-only ryšius |
| strict TS | `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` BAZINIAME tsconfig |
| higiena | tik LF, jokio NUL, NFC normalizacija |

500 eilučių riba yra dydžio, ne grožio taisyklė: failas, kurio nebeįmanoma perskaityti vienu
prisėdimu, nustoja būti riba ir tampa kibiru. Kai riba peržengiama, failas SKAIDOMAS pagal
prasmę (`render-execution-context` → „kas patenka" + „kaip virsta dokumentu"), o ne pagal
eilučių skaičių.

## Paketai

| Paketas | Kodėl atskiras |
|---|---|
| šaknis (`verqestra`) | pats orkestratorius |
| `AG/benchmark` | **kryptis**: matuojamas dalykas negali pasiekti to, kas jį matuoja. Varo CLI kaip procesą (BENCH-1), šaltinių neimportuoja |
| `ui-app` | React dashboard'as su savo toolchain'u; gyvena šaknyje, nes `ui` komanda ieško `packageRoot()/ui-app/dist` |

## Runtime keliai

| Kelias | Kas |
|---|---|
| `vq/state` | būsena, kešas, verdiktų failai |
| `vq/config` | politikos (redaguoja projektas, ne kodas) |
| `vq/logs` | žurnalai |
| `vq/supervisor` | context pack ir execution context |
| `AG/tasks` | darbo eilė (bucket'ai) |
| `AG/spec`, `AG/openspec` | spec kontraktai: mašinai ir žmogui |

`vq/` nėra git'e — tai vieno diegimo būsena. Jos ŠALTINIS yra `templates/`, ir būtent todėl
`verqestra install` yra pilnavertė komanda, o ne patogumas.

## Duomenų kelias: nuo užduoties iki commit'o

```text
AG/tasks/queue/<task>.md
  → preflight            dydis, spec šaltiniai, biudžetas, agentai
  → claude-preflight     OpenSpec kontekstas; be jo — human-review
  → context-pack         užduotis + spec fragmentai + kodo grafas, VIENAS biudžetas
  → dispatch             claude -p headless; allowed_paths yra kieta riba
  → quality-gates        vq/config/quality-policy.json komandos
  → Stop hook            secret-scan → package-guard → migration-guard → commit
```

Kiekviena rodyklė turi savo gedimo kelią, ir nė vienas jų nėra tylus. Tai pagrindinė šio
produkto savybė: **tyli baigtis yra defektas, net jei ji sėkminga.**

## Ryšys su etalonu

VERQESTRA yra kanoninis AG Loop perstatymas. Elgesys perkeltas 1:1, išskyrus įrodomas spragas;
kiekvienas nukrypimas užrašytas trijose vietose (commit'as, etalono `tasks.md`,
`migration-coverage.json`) ir kiekvieno kryptis griežtinanti. Paritetą pin'ina 12
characterization rinkinių (166 atvejai) — žr. [`audits/E8-parity.md`](audits/E8-parity.md).
