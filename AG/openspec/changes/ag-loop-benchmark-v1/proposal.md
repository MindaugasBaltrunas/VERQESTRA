# Proposal: production benchmark for AG Loop

## Problema

Esamas `optimization-benchmark` remiasi istorine telemetrija ir nevienodomis kohortomis. Jis gali aptikti regresiją, tačiau negali pakartojamai palyginti AG Loop su tuo pačiu agentu be AG Loop, nes neturi versijuoto scenarijų rinkinio, izoliuoto runnerio, trijų pakartojimų ir nepriklausomo acceptance verifierio.

## Siūlomas pakeitimas

Monorepo sukurti produkcinį `AG/benchmark` paketą ir integruoti jį su AG CLI, UI bei CI. Benchmarkas vykdys tą patį užšaldytą scenarijų rinkinį izoliuotuose Git worktree, rinks pilną telemetriją, tikrins rezultatą nepriklausomais vartais ir lygins suderinamus baseline/current paleidimus.

## Sėkmės apibrėžimas

Sistema įgyvendinta, kai švarus checkout gali validuoti, vykdyti, pakartoti, palyginti ir atvaizduoti benchmarką; nepilni ar nesuderinami duomenys uždaro vartus; CI tikrina deterministinę dalį; `final-audit` negali paskelbti benchmarko užbaigtu be šviežio įrodymo.

## Ne pažadas

Šis pakeitimas įrodo matavimo sistemos patikimumą. Jis savaime neįrodo, kad AG Loop yra geriausias rinkoje — tokį teiginį gali pagrįsti tik palyginami rezultatai.
