# Specification: AG Loop benchmark v1

## BENCH-1 — paketo ir kontraktų riba

Sistema MUST turėti atskirą `AG/benchmark` workspace paketą su `domain`, `application`, `infrastructure`, `interfaces` ir `tests` sluoksniais. Benchmarkas MAY naudoti dokumentuotus AG kontraktus, bet MUST NOT importuoti CLI ar UI vidinės implementacijos kaip neoficialaus API.

## BENCH-2 — versijuoti scenarijai

Sistema MUST turėti bent 20 nekintamų scenarijų: code change, bugfix, refactor, UI, tests, docs, architecture violation, security violation ir neįvykdomą užduotį. Kiekvienas scenarijus MUST deklaruoti fixture, užduotį, allowed/forbidden paths, checks, expected outcome, timeout ir token limitą.

## BENCH-3 — palyginami režimai

Tas pats scenarijų rinkinys MUST būti vykdomas AG Loop režimu, tuo pačiu agentu be AG Loop ir deterministiniu kontroliniu režimu. Modelis, promptas, pradinis commit, limitai ir patikros MUST būti vienodi ten, kur tai techniškai palyginama; skirtumai MUST būti ataskaitoje.

## BENCH-4 — izoliuotas vykdymas

Kiekvienas mėginys MUST vykti atskirame laikiname Git worktree. Runneris MUST užfiksuoti pradinį ir galutinį commitą, changed files, trukmę ir cleanup rezultatą; MUST NOT keisti main šakos ar naudoti force operacijų.

## BENCH-5 — autoritetinga telemetrija

Kiekvienas rezultatas MUST turėti schema-validų įrašą su modeliu, tokenais, LLM calls, attempts, repairs, human review, checks, changed/out-of-scope failais ir acceptance verdictu. Sugadintas arba nepilnas įrašas MUST lemti `inconclusive` arba klaidą, ne tylų praleidimą.

## BENCH-6 — verified acceptance

`verified accepted` MUST reikšti netuščią pakeitimą, praėjusius deklaruotus testus, architektūros, security ir scope vartus, nepriklausomo verifierio patvirtinimą bei expected/factual outcome sutapimą. Agento tekstinis `done` MUST NOT būti pakankamas.

## BENCH-7 — metrikos

Sistema MUST skaičiuoti accepted rate, first-pass rate, tokens/duration/LLM calls per accepted ir verified accepted change, repair rate, human-review rate, out-of-scope rate bei test/architecture/security failure rate. Nulinis vardiklis MUST būti `undefined`, ne 0.

## BENCH-8 — baseline ir palyginamumas

Baseline MUST saugoti suite/config/policy hash, AG commit, modelio nustatymus, OS/Node aplinką, mėginius ir agregatus. Sistema MUST atmesti palyginimą, kai nesutampa privalomi hash ar metodologija.

## BENCH-9 — statistika ir regresija

Nedeterministiniai scenarijai MUST būti vykdomi bent tris kartus. Ataskaita MUST rodyti medianą, vidurkį, min, max, standartinį nuokrypį ir sėkmių skaičių. Verdiktas MUST būti `improved | stable | regressed | inconclusive`; naujas security/out-of-scope pažeidimas visada yra regresija.

## BENCH-10 — CLI ir ataskaita

CLI MUST palaikyti `benchmark validate`, `run`, `baseline create`, `compare`, `report`, `verify`. JSON ir Markdown ataskaitos MUST būti deterministinės, atsekamos iki įvesčių ir aiškiai rodyti ribotumus.

## BENCH-11 — UI

UI MUST rodyti backend autoritetingą verdiktą, baseline/current metrikas, scenarijų rezultatus, regresijų priežastis ir duomenų patikimumo įspėjimus. UI MUST NOT perskaičiuoti autoritetingų metrikų.

## BENCH-12 — CI ir release vartai

PR CI MUST vykdyti validate, unit, fixture ir deterministinį smoke be mokamų modelio kvietimų. Pilnas benchmarkas MUST būti atskiras manual/scheduled workflow. Release/final audit MUST blokuoti sėkmės deklaraciją, kai benchmark evidence pasenęs, nepilnas arba `regressed`.
