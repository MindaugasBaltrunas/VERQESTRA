# Proposal: VERQESTRA backlog v1

## Kodėl

Migracija baigta (0 pending), bet `backlog-audit` sako `incomplete`: eilė turi vieną atliktą
užduotį, o auditas laukia trylikos produkto sričių padengimo. Tai ne vartų kaprizas — tai
teisingas klausimas: **ką šis produktas dar turi padaryti pats sau?**

Iki šiol atsakymas gyveno etalono `tasks.md` faile ir mano galvoje. Šis change'as perkelia jį
ten, kur jam vieta — į VERQESTRA eilę, sugeneruotą per `verqestra task-generate`.

## Iš kur šios užduotys

Kiekviena eilutė turi šaltinį — E6/E7/E8 auditų radinį arba užrašytą atvirą ribą. Nė viena
nesugalvota tam, kad vartas pažaliuotų: backlog'as, pripildytas raktažodžių, yra tiksliai toks
pat melas kaip tuščias.

## Ko NEdarome

Neįtraukiame darbų, kurių reikalingumo dar neįrodėme. Trylika sričių yra audito kategorijos, ne
kvota — jei sričiai nėra tikro darbo, geriau tegul auditas sako „missing", nei tegul jį uždaro
išgalvota užduotis.
