# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus kritika ir nurodymas pertvarkyti System puslapį

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `#/system` viršuje yra žmogiška būsenos santrauka („kas vyksta dabar ir
ką daryti"), tuščios lentelės įvardija PRIEŽASTĮ, kodėl jos tuščios, ir
puslapyje nebėra begalinės „bėgančios linijos" animacijos —
ALREADY_IMPLEMENTED.

## Tikslas
Operatoriaus kritika (2026-08-28, citatos): „nesąmoningų duomenų kratinys",
„neaišku ką spausti ir kas veikia ir kodėl neveikia", „padarei kaip nežinau
kam, bet ne žmonėms", „laksto kažkokia linija — ar tai top 1 dizainas?".
Kritika pagrįsta: `#/system` rodo vidinius mechanizmus (lease'ai, bangos,
hash'ai), bet neatsako į vienintelį operatoriaus klausimą — kas vyksta
DABAR ir ko iš manęs reikia.

Konkretūs defektai, po vieną pataisą kiekvienam:

1. **Nėra būsenos santraukos.** Viršuje reikia „Kas vyksta dabar" hero:
   vykdomas task'as (arba „ciklas sustojęs — priežastis"), kiek eilėje,
   kiek laukia žmogaus sprendimo (su nuoroda į Reviews), ir VIENAS
   kontekstinis veiksmas (pvz. „Paleisti ciklą", kai jis sustojęs dėl
   atblokuotų task'ų). Duomenys jau yra dashboard snapshot'e — serverio
   keisti nereikia.
2. **Tuščios lentelės meluoja tylėdamos.** Workerių lease lentelė tuščia
   VISADA, kol worktree politika išjungta — vietoj „Aktyvių lease'ų nėra"
   rodyti priežastį: „Worktree politika išjungta
   (vq/config/worktree-policy.json) — lease'ų nebus ir antras srautas
   nepakils". Serveris waves view jau žino politikos būseną arba ją
   pridės (`ui-waves-view.ts`). Tas pats „Bangų detalės": „nėra duomenų"
   → kada jų atsiras.
3. **„User Claude terminal" atrodo kaip sugedęs pultas.** Tai monitorius
   be valdiklių; kai sesijos nėra — arba slėpti bloką už išskleidimo,
   arba aiškiai parašyti „stebėjimo blokas: rodys tavo paleistą Claude
   sesiją; dabar jos nėra". Jokių elementų, kurie atrodo spaudžiami, bet
   nieko nedaro.
4. **Begalinė animacija.** „Laksto linija" — surasti indeterminate
   progress animaciją (tikėtina slot progress / ETA juosta, kuri be
   realių duomenų sukasi amžinai) ir pakeisti statine, sąžininga būsena:
   realus progresas kai yra duomenys, tekstinė būsena kai nėra. Jokių
   amžinų animacijų.
5. **Mygtukai be pasekmių paaiškinimo.** „Stabdyti" drain semantikos
   pastraipa keliama prie paties mygtuko (subtekstas/tooltip), išjungti
   mygtukai visada turi `title` su priežastimi — vienas šablonas visiems
   trims ciklo mygtukams.
6. **Vidinės detalės — žemyn.** Lease'ai, bangų įvykiai, hash'ai ir
   diagnostika lieka, bet po išskleidžiamais `details` blokais žemiau
   hero — ekspertui pasiekiama, žmogui netrukdo.

Dizaino kokybės kartelė ta pati kaip 056: Linear / Stripe Dashboard /
Vercel Geist lygis — aiški hierarchija, ramios spalvos per esamus design
token'us, jokio vizualinio triukšmo, abi temos.

## Agentai
readme-guard -> architect -> coder -> reviewer -> i18n -> tester

## Failai
Leidžiama:
- `ui-app/src/view/components/SystemStatusHero.tsx` (naujas)
- `ui-app/src/view/components/SystemStatusHero.test.tsx` (naujas)
- `ui-app/src/view/pages/DashboardPage.tsx`
- `ui-app/src/view/components/RuntimePanel.tsx`
- `ui-app/src/view/components/RuntimePanel.test.tsx`
- `ui-app/src/view/components/WavesPanel.tsx`
- `ui-app/src/view/pages/WavesPanel.test.tsx`
- `ui-app/src/view/components/SlotProgressCard.tsx`
- `ui-app/src/view/components/SlotProgressCard.test.tsx`
- `ui-app/src/model/types.ts`
- `ui-app/src/model/api.ts`
- `ui-app/src/i18n/I18nContext.tsx`
- `ui-app/src/view/styles/dashboard.css`
- `src/interfaces/http/ui-waves-view.ts` (TIK worktree politikos būsenos
  laukas tuščios lentelės priežasčiai)
- `src/tests/interfaces-http-waves.test.ts` (numatomas; jei testas gyvena
  kitame faile — tas failas vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- `src/application/**`
- `src/domain/**`
- `ui-app/src/controller/**` (jei hero pareikalaus naujo controller lauko —
  stop ir klausk)
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect pirmas: hero informacijos hierarchija ir kuris blokas kur
  keliauja (validuoja prieš 6 defektų sąrašą; nieko nešalina — tik
  perorganizuoja ir įvardija).
- Coder įgyvendina; kiekviena nauja className — taisyklė `dashboard.css`;
  nauji tekstai per `t(...)`.
- Tester: hero rodo teisingą būseną trims scenarijams (ciklas vykdo /
  sustojęs dėl approval / sustojęs be darbo), tuščios būsenos rodo
  priežastis, animacijos nebėra.

## Patikra
- `pnpm typecheck && pnpm test`
- `pnpm --dir ui-app build`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei pertvarka pareikalautų
keisti controller sluoksnį ar serverio kontraktus plačiau nei vienas
waves view laukas.

## Neįtraukta
Naujų duomenų šaltinių kūrimas serveryje (išskyrus worktree politikos
lauką waves view). „Eilės srautas" blokas — jau pašalintas (057).
Perbuild mygtukas — 058. Reviews puslapio dropdown'ai — 056.
