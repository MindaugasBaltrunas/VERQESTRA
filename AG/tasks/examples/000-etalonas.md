# Task

ETALONAS (2026-08-29). Šis failas yra KANONINIS task'o šablonas: kiekvienas
task'as — žmogaus ar generatoriaus kurtas — privalo turėti visas žemiau
išvardytas sekcijas šia tvarka. Komentarai `> ...` aiškina taisykles ir į
tikrą task'ą NEkopijuojami. Taisyklių šaltinis: 2026-08-28 incidentų serija
(5 parkavimaisi dėl per siauro ## Failai, 2 nepavykę auto-skėlimai, 3 retry
sargo blokai) — kiekviena taisyklė čia uždaro realiai įvykusią klaidą.

HUMAN-REVIEW-APPROVED: <kas> <YYYY-MM-DD> <trumpa priežastis>

> Žymos eilutė dedama TIK kai žmogus jau priėmė sprendimą (rizikos vartai,
> platus scope, kontrakto keitimas). Be sprendimo — eilutės NĖRA. Žyma
> rašoma tuoj po `# Task`; leidžiamas bullet prefiksas. Žymą rašo TIK
> žmogus arba jo tiesioginiu nurodymu.

## Spec source
openspec/changes/<change-katalogas>

## Priklausomybės
- <pilnas-task-id-be-md>

> Neprivaloma sekcija. Id privalo egzistuoti bet kuriame bucket'e (task 136:
> loop'o tranzitas per active/human-review nedaro nuorodos neteisinga), BET
> planą tenkina tik done — priklausomybė į human-review gyventoją tampa
> `invalid-terminal-dependency` ir užblokuoja VISĄ eilę, kol jis grįš per
> requeue. Placeholder'iai („none", „-") draudžiami — arba tikras id, arba
> sekcijos nėra. Skeliant tėvą, UI vaikas priklauso nuo serverio vaiko, ne
> atvirkščiai.
> KIEKVIENA priklausomybė kainuoja w2 slot'ą: deklaruok ją TIK realiam
> tvarkos reikalavimui (kontraktas, kurio antras task'as negali statyti
> nesulaukęs) arba realiam failų persidengimui — NE „dėl visa ko".
> Atsargumo priklausomybė tarp nepriklausomų task'ų = tyčinis lygiagretumo
> atsisakymas.

## Žingsnis 0 — ar jau įgyvendinta?
Jei <konkreti, grep'u/Read patikrinama sąlyga su failų keliais> —
ALREADY_IMPLEMENTED: <failai/eilutės kaip įrodymas>.

> Sąlyga privalo būti PATIKRINAMA (failas + ko jame ieškoti), ne abstrakti.
> ALREADY_IMPLEMENTED ataskaitoje privalo turėti įrodymą — be jo užbaigimo
> sargas bėgimą atmes. Jei ankstesnis bandymas buvo nukirstas — įvardyk,
> kad dalis darbo gali jau būti kode ir tikrinti reikia po punktą.

## Tikslas
<Problema su ĮRODYMU (log eilutė, failas:eilutė, operatoriaus citata su
data) ir sprendimo kryptis. Jei sprendimas atmeta alternatyvą — įvardyk
kurią ir kodėl.>

> Tikslas be įrodymo yra spėjimas. Data ir šaltinis privalomi, kad po
> savaitės būtų aišku, ar problema dar egzistuoja.

## Agentai
readme-guard -> <grandinė pagal scope iš .claude/rules/agents.md>

> UI feature: readme-guard -> architect -> coder -> reviewer -> i18n -> tester
> Domain/logika: readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester
> Klaidos taisymas: readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `tikslus/kelias/iki/failo.ts`
- `tikslus/kelias/iki/failo.test.ts` (numatomas naujas; jei testas gyvena
  kitur — tas failas vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- `dist/**`
- `node_modules/**`

> SVARBIAUSIA SEKCIJA — planuoklė iš jos sprendžia lygiagretumą, o diagnozė
> po bėgimo tikrina ribas. Taisyklės:
> 1. TIK konkretūs keliai. Katalogo wildcard'as (`src/tests/**`,
>    `components/`) atima lygiagretumą, veda preflight'ą į skėlimą ir yra
>    leidžiamas TIK visos apimties migracijai su pagrindimu šalia.
> 2. KIEKVIENAS produkcinis failas ateina su savo testo failu sąraše.
>    Nežinai vardo — įrašyk numatomą su išlyga (žr. pavyzdį viršuje):
>    klaidingas konkretus kelias pastebimas, wildcard'as — ne.
> 3. UI task'as VISADA įtraukia `ui-app/src/i18n/I18nContext.tsx` (nauji
>    tekstai) ir `ui-app/src/view/styles/dashboard.css` (naujos className —
>    CSS dengiamumo vartas). Jei keiti mygtukus — patikrink, ar jie negyvena
>    LoopControls/ConfirmButton tipo vaikuose, ne tik tėviniame komponente.
> 4. Serverio HTTP pakeitimas beveik visada liečia ir `ui-router-model.ts`
>    (route tipai) bei `ui-error-mapping.ts` (klaidų kodai) — pagalvok apie
>    juos IŠ ANKSTO, ne po rollback'o.
> 5. Kontraktų keitimas liečia ir kontraktų testus
>    (`interfaces-http-router-contracts.test.ts` ir pan.).
> 6. Draudžiama sekcija įvardija tai, kas NETYČIA pakliūtų: gretimas
>    sluoksnis, svetimas modulis, `dist/**`, `node_modules/**`.
> 7. W1/W2 LYGIAGRETUMAS: kurdamas KELIS task'us vienu metu, patikrink jų
>    porų sankirtas — du task'ai be tarpusavio priklausomybės NEGALI
>    dalintis nė vienu keliu (planuoklė kertantį porą serializuoja ir
>    antras slot'as lieka tuščias). Bendras failas → arba sąmoninga
>    `## Priklausomybės` eilutė, arba bendras pakeitimas iškeliamas į
>    atskirą smulkų task'ą, nuo kurio abu priklauso.
> 8. HOTSPOT failai, kurie serializuoja beveik visus UI task'us:
>    `ui-app/src/i18n/I18nContext.tsx`, `ui-app/src/view/styles/dashboard.css`,
>    `ui-app/src/model/types.ts`, `ui-app/src/model/api.ts`. Planuok UI
>    task'ų partijas taip, kad vienu metu eilėje stovėtų daugiausia VIENAS
>    hotspot'us liečiantis task'as, o kiti tuo metu — be jų.
> 9. PIN'INANTYS TESTAI: jei task'as keičia reikšmę, kurią testas tvirtina
>    literalu, tas testas PRIVALO būti sąraše — kitaip vykdytojas jį
>    pataiso (kitaip `pnpm test` raudonas), diagnozė mato „outside allowed
>    paths", o rollback'as jau užcommit'into darbo negrąžina ir task'as
>    parkuojasi. Žinomi atvejai: `CONTEXT_CACHE_VERSION` kėlimas VISADA
>    liečia `src/tests/context-pack-code-index-identity.test.ts` ir
>    `src/tests/context-pack-guards.test.ts` (task 138, 2026-09-02);
>    `codeIndexVersion` — tą patį identity testą. Prieš deklaruodamas
>    Grep'ink keičiamos konstantos vardą per `src/tests/`.

## Veiksmas
- <žingsnis su vieta kode: failas, funkcija, ką keisti>
- <testų lūkestis: kokie atvejai tvirtinami>

> Konkretu, bet be mikro-valdymo: worker'is turi žinoti KUR ir KĄ, spręsti
> KAIP gali pats. Jei ankstesnio bandymo darbas išsaugotas
> (`refs/verqestra/preserved/...`) — nurodyk ref'ą ir leisk atkurti.

## Patikra
- `pnpm build`
- `pnpm test`

> TIK šios dvi formos (be pipe, be `--`, be `build:ui`/`test:only` variantų
> — sandbox jas atmeta ir kiekvienas atmetimas degina turn'ą). UI task'ui
> papildomai leidžiama `pnpm --dir ui-app build`. Kitokių komandų reikia —
> pagrindimas šalia.

## Stop
Commit'ink, kai patikros žalios. <+ konkreti stop sąlyga, jei darbas gali
atsiremti į svetimą sprendimą — „stop ir klausk, jei X">

## Neįtraukta
<Kas SĄMONINGAI nedaroma ir kur tai bus daroma (kito task'o id, jei žinomas).
Bent viena eilutė — tuščia sekcija reiškia neapgalvotą apimtį.>
