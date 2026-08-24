# VERQESTRA UI kontrolinis auditas

Data: 2026-08-24  
Versija: švarus darbo medis, `dist/cli.js` surinktas 2026-08-24 16:55  
Peržiūros dydžiai: 1440 × 1000 ir 390 × 844  
Būsena: **reikia pataisymų prieš pasitikint analitika ir Sistemos mobiliu vaizdu**

## Santrauka

Dabartinė versija turi tvirtą vizualinį pagrindą: aiškią tamsią temą, nuoseklias korteles, gerai matomus būsenų signalus, kompaktišką mobilų antraštės juostos variantą ir be horizontalaus persipildymo susidėliojantį mobilų Užduočių ekraną. Naršyklės konsolėje audito metu nebuvo klaidų ar perspėjimų.

Du didžiausi likę pavojai:

1. Analitika tą patį duomenų rinkinį skaičiuoja dviem skirtingais būdais. Viršuje rodoma 1 unikali užduotis ir 352 595 tokenai užduočiai, o žemiau – 2 užduotys, 176,3 tūkst. vidurkis ir tuščia 0 tokenų eilutė.
2. Sistemos ekranas 390 px plotyje išplečia dokumentą iki 444 px. Tai sukuria viso puslapio horizontalų slinkimą; plati `usage-table` nėra pilnai izoliuota savo slinkimo konteineryje.

## Prioritetiniai radiniai

### P1 — Analitikos agregacijos nesutampa

Ekrano viršuje rodoma:

- `UNIKALIOS UŽDUOTYS: 1`;
- `TOKENAI / UŽDUOČIAI: 352 595`.

Tame pačiame filtrų rinkinyje žemiau rodoma:

- `2 užduočių`;
- `VIDURKIS UŽDUOČIAI: 176,3 tūkst.`;
- viena tuščio ID eilutė su 1 įrašu ir 0 tokenų;
- paskirstymo kortelėje `med 0 · p95 352 595`.

Tai ne vien kosmetika: tuščias `task_id` patenka į dalį agregacijų, bet ne į visas, todėl vidurkiai ir percentiliai klaidina. Reikia vienos taisyklės visoms suvestinėms: arba atmesti tuščią ID prieš agreguojant, arba nuosekliai rodyti jį kaip „Nepriskirta“ visose metrikose. Verta pridėti invariantinį testą, kad kortelių užduočių skaičius sutaptų su lentelės grupių skaičiumi.

### P1 — Sistemos ekranas persipildo mobiliame plotyje

390 px peržiūroje užfiksuota:

- `document.documentElement.scrollWidth = 444`;
- `innerWidth = 390`;
- pagrindinės Sistemos kortelės baigiasi ties ~443,9 px;
- `usage-table` vidinis plotis yra ~850 px.

Plati lentelė gali slinkti lokaliai, tačiau jos min-content plotis vis tiek išplečia aukštesnį grid/flex takelį. Rekomendacija: pridėti `min-width: 0` grid/flex vaikams, `max-width: 100%` kortelėms ir aiškų `overflow-x: auto` ties tiesioginiu lentelės konteineriu. Reikalingas 390 px regresinis vaizdo testas Sistemai.

### P2 — Sprendimų eilė nepaaiškina kelių pasiūlymų tam pačiam nustatymui

Viršutinė suvestinė dabar naudingai atskiria `2 nustatymai laukia sprendimo` nuo `3 reikalauja veiksmo`, todėl ankstesnė skaičių kolizija tapo semantiškai paaiškinama. Tačiau eilėje du `open_closed` pasiūlymai rodomi kaip atskiros beveik identiškos kortelės, abi keičia `advisory → block`, ir nėra grupavimo, konflikto žymos ar paaiškinimo, ar patvirtinus vieną kitas taps nebegaliojantis.

Rekomendacija: grupuoti pagal `policy file + setting`, viršuje rodyti „2 pasiūlymai šiam nustatymui“, o identišką tikslinę reikšmę sujungti arba aiškiai parodyti tarpusavio poveikį.

### P2 — LT režime lieka mišri produkto kalba

Užduočių būsenos lieka `queue`, `active`, `delegated`, `error`, `failed`, `human-review`, `done`. Sistemoje taip pat matomi `scheduler`, `worker`, `lease`, `default`, `implementation`, `ui-loop.pid not recorded` ir angliški automatikos politikų pavadinimai.

Operatorių įrankyje dalis techninių identifikatorių gali likti originalūs, tačiau dabar nėra aišku, kas yra nekintamas kodinis ID, o kas – neišversta sąsajos etiketė. Rekomendacija: kodinius terminus rodyti monospace ženkleliais, o vartotojo veiksmų ir būsenų etiketes lokalizuoti nuosekliai.

### P2 — Puslapio antraštė nėra pagrindinis H1

Patikrintame Užduočių ekrane vienintelis `H1` yra prekės ženklas `VERQESTRA`; puslapio pavadinimas `Užduotys` yra `H2`. Ekrano skaitytuvų antraščių navigacijoje tai silpnina puslapio orientyrą.

Rekomendacija: prekės ženklą pateikti kaip nuorodą arba neutralų elementą, o aktyvaus ekrano pavadinimą naudoti kaip vienintelį `H1`.

### P3 — Datos valdikliai prieštarauja LT kontekstui

LT režime naršyklė datos laukuose rodo `mm/dd/yyyy`, o pagalbinis tekstas sako `YYYY-MM-DD`. Paaiškinimas, kad vaizdas priklauso nuo naršyklės kalbos, yra sąžiningas, tačiau formos pirmas įspūdis vis tiek prieštaringas.

Rekomendacija: šalia kiekvieno lauko pateikti trumpą pavyzdį arba naudoti lokalizuotą, naršyklės placeholder'iui nepriklausantį datos įvedimo sluoksnį.

### P3 — Mobilus „Daugiau“ meniu reikalauja vidinio slinkimo

390 × 844 ekrane meniu talpina devynis ekranus ir įrankius viename aukštame sluoksnyje. Atnaujinimo, temos ir kalbos valdikliai lieka žemiau pirmo matomo ploto, todėl būtinas atskiras meniu slinkimas.

Rekomendacija: dažniausius 4–5 ekranus laikyti pagrindinėje navigacijoje, retesnius sugrupuoti, o kalbą ir temą perkelti į kompaktišką nustatymų bloką.

### Stebėjimas — vienkartinis slinkties šuolis

Pirmą kartą perėjus iš apatinės Peržiūrų dalies į Sistemą, Sistema buvo užfiksuota viduryje turinio. Vėliau pereinant iš Analitikos į Sistemą `scrollY` buvo 0, todėl šio elgesio nepavyko stabiliai pakartoti. Tai verta patikrinti automatiniu maršrutų testu, bet šis auditas jo nelaiko patvirtintu defektu.

## Kas veikia gerai

- Pagrindinės būsenos turi ir spalvą, ir tekstą; ryšio bei duomenų šviežumo signalai nėra vien spalviniai.
- Užduočių ekranas 390 px plotyje susideda į vieną koloną be horizontalaus persipildymo.
- Paslėptas failo įvedimo laukas dabar turi `tabIndex = -1`, `pointer-events: none`; klaviatūros fokusas paliekamas matomam „Pasirinkti“ mygtukui.
- `html lang="lt"`, yra `header`, du `nav` ir `main` orientyrai; patikrintame ekrane nerasta neįvardytų mygtukų ar paveikslų be `alt`.
- Mobilus antraštės aukštis kompaktiškas, aktyvus ekranas ir „Daugiau“ valdiklis išlieka matomi.
- Audito metu naršyklės konsolėje nebuvo `error` ar `warning` įrašų.

## Ekranų eiga

1. **Apžvalga — gera.** Aiški informacijos hierarchija ir būsenų santrauka. Paskutinė signalų kortelė lieka viena kitoje eilėje, todėl tinklelis vizualiai nesubalansuotas, bet tai žemo prioriteto klausimas.

   ![Apžvalga](./01-overview-desktop.png)

2. **Užduotys — reikia dėmesio.** Darbo lentos struktūra skaitoma, įkėlimas aiškus; būsenų etiketės LT režime lieka angliškos.

   ![Užduotys](./02-tasks-desktop.png)

3. **Peržiūros — daugiausia gera.** `2 nustatymai laukia sprendimo` atskirta nuo pasiūlymų skaičiaus, filtrai ir politikų kortelės aiškūs.

   ![Peržiūros](./03-reviews-desktop.png)

4. **Sprendimų eilė — reikia dėmesio.** Du `open_closed` pasiūlymai nėra sugrupuoti; datos ir `human-review` rodomi techniniu formatu.

   ![Sprendimų eilė](./04-review-queue-desktop.png)

5. **Sistema — reikia ištirti.** Ši pirmoji navigacija atsidarė viduryje ilgo ekrano; vėliau elgesio pakartoti nepavyko.

   ![Sistema po navigacijos](./05-system-desktop.png)

6. **Analitikos suvestinė — reikia dėmesio.** Viršutinė kortelė teisingai rodo 1 unikalią užduotį, bet to paties ekrano paskirstymo vidurkiai jau įtraukia tuščią grupę; datos placeholder'is lieka `mm/dd/yyyy`.

   ![Analitikos suvestinė](./06-analytics-desktop.png)

7. **Užduočių analitika — kritinis duomenų pasitikėjimo radinys.** Matoma tuščia 0 tokenų eilutė, `2 užduočių` ir perpus sumažintas vidurkis.

   ![Užduočių analitikos lentelė](./07-analytics-tasks-desktop.png)

8. **Mobilus meniu — reikia dėmesio.** Navigacija veikia, bet meniu ilgas, turi vidinį slinkimą; po juo matomas Sistemos horizontalus persipildymas.

   ![Mobilus meniu](./08-mobile-menu.png)

9. **Mobilios Užduotys — gera.** Kortelės sudėtos į vieną koloną, failo pasirinkimas aiškus, viso puslapio horizontalus slinkimas neatsiranda.

   ![Mobilios Užduotys](./09-mobile-tasks.png)

## Prieinamumo ribos

Tai nėra pilnas WCAG atitikties auditas. Buvo patikrinta pagrindinė semantika, orientyrai, antraščių struktūra, mygtukų pavadinimai, paveikslų `alt`, paslėpto failo lauko fokuso elgsena ir keli reprezentatyvūs mobilūs vaizdai. Nebuvo atliktas pilnas klaviatūros maršrutas, ekrano skaitytuvo testas, automatizuotas kontrasto matavimas ar kelių naršyklių palyginimas.

## Audito ribos

- Auditas buvo tik skaitomas: ciklas nepaleistas, failai neįkelti, politikų pasiūlymai nepatvirtinti ir neatmesti.
- Patikrinti tik 1440 × 1000 ir 390 × 844 dydžiai in-app Chromium naršyklėje.
- Duomenų teisingumas vertintas pagal vidinį UI nuoseklumą; pirminiai telemetrijos failai šiame UX audite nebuvo perskaičiuoti atskirai.
