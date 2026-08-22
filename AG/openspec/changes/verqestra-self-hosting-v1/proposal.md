# Proposal: VERQESTRA self-hosting v1

## Kodėl

Migracija iš AG_loop baigta: coverage ledger'yje 0 pending, visi trys paketai žali
(šaknis 1380 testų, `ui-app` 393, `AG/benchmark` 701/704 = VQ-001 baseline). Bet produktas dar
nė karto nevaldė SAVO paties repozitorijos: vartai buvo tikrinami testais ir sandbox'e, ne
gyvame cikle.

Tai skirtumas, kurį verta pasakyti garsiai. Testas įrodo, kad komponentas elgiasi taip, kaip
parašyta. Gyvas ciklas įrodo, kad komponentai VIENAS SU KITU susijungia realiame medyje su
realiais konfigais — ir būtent tos siūlės E5–E7 metu lūžo dažniausiai (neprijungtas hook'as,
maršrutas be kliento, `install` be šablonų).

## Ką keičiame

VERQESTRA pradeda vykdyti savo pačios užduotis: eilė `AG/tasks/queue`, hook'ai per
`.claude/settings.json`, commit'as per Stop vartą.

## Ko NEkeičiame

- Architektūros ribų ir vartų griežtumo — self-hosting neduoda išimčių sau pačiam.
- Etalono (`D:\React\AG_loop`) — jis lieka read-only iki operatoriaus cutover sprendimo.
- Auto-push politikos: šiame repo ji išjungta, kol operatorius nenuspręs kitaip.

## Rizika

Autonominis agentas redaguoja tą patį medį, kuriame gyvena jį valdantis kodas. Riba yra
task'o `allowed_paths` plius preflight, quality gates ir guard'ai — t. y. tas pats mechanizmas,
kurį produktas siūlo svetimiems projektams. Jei jis nepakankamas sau, jis nepakankamas ir jiems.
