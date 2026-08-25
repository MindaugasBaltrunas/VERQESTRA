# VERQESTRA produkto specifikacija

Requirement rinkinys, aprašantis, **ką produktas privalo daryti** — atskirai nuo migracijos
plano (`migration-coverage.json`), kuris aprašo, *iš kur* jis atsirado. Migracijai pasibaigus
šis dokumentas lieka; migracijos ledger'is — ne.

Kiekvienas reikalavimas turi ID, kad testai, auditai ir task'ai galėtų į jį rodyti. Statusas
nerašomas prie reikalavimų sąmoningai: tiesos šaltinis apie „ar veikia" yra vartai
(`pnpm test`), ne dokumento žyma, kuri pasensta tyliai.

## 1. Produkto apibrėžimas

VERQESTRA — spec-first orkestravimo karkasas riboto scope AI kodavimo agentams: užduočių eilė,
bangomis planuojamas vykdymo ciklas, kontekstų surinkimas, kokybės vartai ir įrodymais grįstas
užbaigimas viename CLI (`verqestra`, vienintelis įėjimas — `src/cli.ts`).

- **PR-1** Produktas valdo pilną užduoties gyvavimo ciklą: spec → task generavimas → eilė →
  dispatch → verifikacija → terminalinė būsena (`done` / `human-review` / `error`), su
  įrodymu kiekviename žingsnyje.
- **PR-2** Vienintelis vykdymo autoritetas yra kanoninis task DAG (`buildTaskGraph` →
  `buildReadySet` → `applyReadySetGates`): grafo draudimas negali būti apeitas jokiu vykdymo
  keliu, o grafo nebuvimas ar klaida blokuoja bangą, ne praleidžia ją.
- **PR-3** Agento žodis niekada nėra įrodymas. Užduotis uždaroma `done` tik su patikrinamu
  darbo pėdsaku (produkto kelių commit'as su task tapatybe); be jo — `human-review`, iš kurio
  išeina tik žmogaus sprendimas.

## 2. Užduočių eilė ir DAG

- **QUE-1** Užduotys gyvena `AG/tasks/<bucket>/` failuose; bucket'ai yra ledger'io tiesos
  šaltinis, o `task-ledger-sync` ledger'į derina prie failų, ne atvirkščiai.
- **QUE-2** Task tapatybė yra tiksli (`isSameTask`); prefiksinė nuoroda leidžiama tik
  rezoliucijai prieš PILNĄ visatą, o dviprasmybė yra klaida, ne pirmas kandidatas.
- **QUE-3** Priklausomybės (`## Dependencies`, `depends_on`) sudaro aciklinį grafą; ciklas,
  nesama priklausomybė ar `human-review` laukianti šaka blokuoja TIK ją vardijančią atšaką.
- **QUE-4** `graph_hash`/`decision_hash` atspaudai imami nuo VERDIKTŲ: joks vartų įėjimas
  negali pasikeisti nepakeitęs vykdymo plano tapatybės.
- **QUE-5** `requeue` yra aiškus žmogaus „bandyk dar kartą": jis atstato biudžeto skaitiklius
  ir grąžina užduotį į eilę nepalikdamas pasenusių guard įrašų.

## 3. Vykdymo ciklas (loop)

- **LOOP-1** `verqestra loop` vykdo eilę bangomis iki tuščios eilės arba operatoriaus stabdymo;
  exit kodas yra kontraktas: `0` — darbas baigtas arba sustabdyta, `1` — sustota paliekant
  darbą (išsekusi banga, užterštas medis, nedispatch'intas slot'as).
- **LOOP-2** Prieš startą bėga fail-closed prielaidos: šviežias `dist`, švarus produkto medis,
  gyvų lease'ų higiena, git `index.lock` patikra. Kritusi prielaida blokuoja startą garsiai.
- **LOOP-3** Kiekvienas slot'as dirba izoliuotoje worktree kopijoje su savo lease; lease
  turi nuosavybės tokeną, o jo atlaisvinimas niekada netrina svetimo lock'o
  (`shared/owned-lock`: fencing + gyvybės žymė).
- **LOOP-4** Crash'as yra numatyta būsena: resume atkuria bandymą iš attempt evidencijos, o
  ne iš agento pasakojimo; svetimas ar pasenęs stop įrašas atmetamas pagal task tapatybę.
- **LOOP-5** Telemetrijos rašymo klaida niekada nenutraukia bangos; būsenos (snapshot,
  checkpoint) rašymo klaida — nutraukia, nes tyli jos netektis reikštų prarastą resume tašką.

## 4. Dispatch ir biudžetai

- **DSP-1** Kiekvienas dispatch'as eina pro preflight (dydis, spec šaltiniai, agentų grandinė,
  biudžetas) ir gauna deterministinį verdiktą; infrastruktūrinis kritimas stabdo ciklą, o ne
  virsta užduoties kaltinimu.
- **DSP-2** Token biudžetai vykdomi dispatch'o metu (`enforceExecutionBudget`,
  `authorizeLlmCall`): pasiektos lubos atmeta kvietimą PRIEŠ jį apmokant.
- **DSP-3** Retry yra ribotas ir memo'izuotas: nepakitęs turinys po realaus preflight kritimo
  nekartojamas; aplinkos pataisymas kilpos nesukuria (infra exit'as memo nerašo, žalias
  preflight'as jį išvalo).
- **DSP-4** Modelio maršrutas kyla pakopomis pagal politiką ir niekada nepraeina virš
  deklaruotų lubų; maršruto sprendimas su priežastimi paliekamas žurnale.

## 5. Konteksto paketas (context pack)

- **CTX-1** Worker'io kontekstas surenkamas deterministiškai iš deklaruotų šaltinių (spec
  fragmentai, kodo pjūviai, architektūros mazgai) su simbolių biudžetu; praradimai deklaruojami
  (`truncated`, `dropped_count`), niekada netylimi.
- **CTX-2** Retrieved turinys yra DUOMENYS, ne instrukcijos: laisvas repo tekstas eina į
  `retrieved_data` aptvarą su `untrusted` žyma, o trust taisyklė renderinama PRIEŠ payload'ą.
- **CTX-3** Visi task-kilmės keliai tikrinami prieš projekto ribas (realpath containment);
  už ribų vedantis kelias deklaruojamas, bet niekada neskaitomas.
- **CTX-4** Kešo raktas apima šaltinių turinį IR pack semantikos versiją
  (`CONTEXT_CACHE_VERSION`); loginis pakeitimas be versijos pakėlimo laikomas defektu.
- **CTX-5** `allowed_paths` yra kieta redagavimo riba ir niekada nekarpoma tyliai: netilpusi
  riba yra garsus gedimas, ne nukirpta deklaracija.

## 6. Kokybės vartai ir saugumo politika

- **QG-1** `pnpm test` = lint → build → testai; architektūros vartai (sluoksnių kryptys,
  500 eilučių riba, aciklinis importų grafas, LF/NUL/NFC higiena) bėga be baseline.
- **QG-2** Kiekvienas produkcinis eksportas turi kvietėją arba įvardytą priežastį
  (`dead-export-gate`): neprijungtas mechanizmas yra užrašyta skola, ne tylus faktas.
- **QG-3** Bash/rašymo politika yra allowlist + denylist, kur allowlist niekada neperrašo
  denylist'o; runtime keliai (`vq/state`, supervisor artefaktai, readme-guard evidencija)
  agentui nerašomi tiesiogiai.
- **QG-4** Guard'ai (secret-scan, package, migration, frontend/backend/mobile) bėga fan-out'u
  po rašymų ir stop'e; guard'o radinys blokuoja su nuoroda į žurnalą.
- **QG-5** Stop hook'as commit'ina tik šios sesijos rašymus (niekada `git add --all`);
  autorinė commit žinutė ir darbas, kurį ji aprašo, išgyvena arba išsivalo kartu.

## 7. Įrodymai ir runtime

- **EV-1** Runtime artefaktai gyvena `vq/{state,config,logs,project,architecture,generated}`;
  eilės ir paketo kontraktai lieka `AG/…`. Runtime keliai negali pabėgti iš savo šaknies
  (path containment pagal konstrukciją).
- **EV-2** Attempt store yra vienintelis `vq/runtime/**` rašytojas: tapatybė įrodoma manifestu,
  įvestys write-once, baigtys compare-and-swap; klaida yra reikšmė, ne išimtis.
- **EV-3** Stop-bridge įrašas egzistuoja KIEKVIENAI stop baigčiai; attempt-first tvarka, nes
  globalus `done` yra watchdog trigger'is.
- **EV-4** Token apskaita append-only su requeue reset žymomis; kaina raportuojama tik iš
  įrašų, kurie ją turi, ir niekada neekstrapoliuojama tylomis.

## 8. Operatoriaus paviršiai

- **OP-1** CLI komandų registras yra vienintelis šaltinis; README „Main Commands" ir registras
  tikrinami vienas prieš kitą (`readiness-audit` krenta ties nedokumentuota komanda).
- **OP-2** Dashboard'as (`verqestra ui`, 127.0.0.1) rodo eilę, bangas, biudžetus ir žurnalus
  iš tų pačių runtime šaltinių, kuriais remiasi loop'as; degradavęs šaltinis deklaruojamas
  vartotojui, ne nutylimas.
- **OP-3** `human-review` bucket'as yra operatoriaus parašo vieta: išėjimas iš jo — tik
  `task-move` į `done` (viena kryptis) arba `requeue`.
- **OP-4** Hook'ai į Claude Code jungiami tik per `.claude/settings.json` šablonus; visi
  registruoti hook'ai turi kvietėją settings'uose arba fan-out'e, arba dokumentuotą
  „not wired by default" statusą.

## 9. Matavimas

- **BM-1** `@verqestra/benchmark` matuoja orkestratorių iš išorės: paketas nėra orkestratoriaus
  priklausomybė ir įkeliamas pagal kelią, kad matuoklis nesidalintų kodu su matuojamu.
- **BM-2** Tinklo/mokamas vykdymas išjungtas pagal nutylėjimą (`--allow-network` privalomas);
  atsisakymas įvyksta sprendžiant planą, prieš apmokant pirmą celę.
- **BM-3** Exit kodai skiria „matavimas sako ne" (`1`) nuo „matavimo nebuvo" (`2`–`5`);
  release vartai šių dviejų niekada nesulieja.
- **BM-4** Kaštai skaičiuojami dviem pagrindais (`perAcceptedChange` — agento deklaracija,
  `perVerifiedAcceptedChange` — verifikatoriaus) ir tarpas tarp jų pats yra matavimas.

## 10. Ne-tikslai

- **NG-1** VERQESTRA nevaldo realios DB ir neaplikuoja migracijų be žmogaus patvirtinimo.
- **NG-2** Joks agento kelias negali publikuoti, push'inti ar kurti PR be aiškaus leidimo.
- **NG-3** Produktas nesiima naršyklės, scraper'ių ar vector DB integracijų — kontekstas
  renkamas iš repo ir deklaruotų spec šaltinių.
