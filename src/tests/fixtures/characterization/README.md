# Characterization fixtures (PAR-1)

Duomenų failai čia yra PAŽODINĖS AG_loop etalono kopijos
(`AG/orchestrator/src/tests/fixtures/characterization/`). Jų NIEKADA neredaguojame
šiame repo: nesutapimas su runner'io rezultatu reiškia, kad VERQESTRA pakeitė
užšaldytą elgesį — taisomas kodas, ne fixture. Record režimo VERQESTRA runner'iai
neturi ir negali turėti.

| Failas | Sritis | Banga |
|---|---|---|
| `shared-primitives.json` | canonical JSON, normalizuotas sha256, shortDigest erdvė | E1 (VQ-101) |
| `task-sections.json` | task sekcijų enumeravimas, heading foldingas, bullets | E2 (VQ-201) |
