# Claude Agent Workflow

## 0. readme-guard — pirmas source pakeitimų žingsnis

Pilną projekto `README.md` (ir architektūros dokumentą) grandinėje skaito tik
`readme-guard` — PostToolUse Read hook'as skaitymą užfiksuoja visai sesijai, o
readme-guard grąžina ribų santrauką tolesniems agentams.

Kiekvienas tolesnis agentas prieš keisdamas skaito tik:

1. readme-guard ribų santrauką (perduodama užduoties prompte).
2. Scope specifinę dokumentaciją, jei ji egzistuoja.
3. Užduoties failą, spec arba issue, pagal kurį dirbama.
4. Failus, kuriuos ketina keisti.

Pilną `README.md` skaityk tik jei santraukos nepakanka ar kyla abejonė dėl ribų.
Jei README ir agento instrukcija konfliktuoja, laimi README.

## 1. Nustatyti scope

```text
Scope: package | app | module | worker | docs | config | tests
Tikslas: ...
Leistini failai: ...
Draudžiami failai: ...
Public kontraktai: ...
Reikalingi testai: ...
```

## 2. Patikrinti ribas

Blokuok arba eskaluok, jei:

- pakeitimas importuoja svetimo modulio ar feature vidinius failus;
- business logika dedama į netinkamą sluoksnį;
- reikia DB, auth, public API ar dependency pakeitimo, bet užduotis to neapima;
- keičiamas generated/runtime/secret failas;
- reikėtų trinti ar pervadinti failus be aiškaus cleanup pagrindo;
- testas būtų silpninamas vietoje realios klaidos pataisymo.

## 3. Įgyvendinti mažiausią saugų pakeitimą

- Keisk tik failus, kurie priklauso scope.
- Refaktorink tik kai tai sumažina realų dubliavimą, pasenusį kodą arba aiškiai pagerina ribas.
- Išsaugok backward compatibility, jei užduotis neprašo breaking change.
- Dokumentuok elgesio arba kontrakto pakeitimus.

## 4. Tikrinti darbą

Paleisk projekto realias kokybės komandas. Tipinis rinkinys:

```bash
npm run build
pnpm test
pnpm test:architecture
```

Jei komandos skiriasi, naudok projekto README arba package scripts. Jei patikra nepaleista, nurodyk priežastį.

## 5. Užbaigimo ataskaita

```text
Pakeista:
- ...

Ribos:
- Scope: ...
- Ko neliečiau: ...

Testai:
- ...

Rizikos:
- ...
```