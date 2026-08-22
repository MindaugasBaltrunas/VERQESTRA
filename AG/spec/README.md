# AG/spec — specifikacijų kontraktai

Čia gyvena spec change'ai, kuriuos skaito `verqestra spec-drift` ir `verqestra milestone-check`:

```text
AG/spec/changes/<change-id>/spec.json
```

`spec.json` privalo turėti `id`, `status` (`active` | `done`) ir `scope` (glob'ų sąrašas).
`milestone-check` ima PIRMĄ (abėcėlės tvarka) `status: "active"` įrašą; `spec-drift` lygina
pakeistus failus su to įrašo `scope` ir raportuoja viską, kas iškrito iš ribų.

Kodėl atskirai nuo `AG/openspec`: `openspec` yra ŽMOGUI skirtas pasiūlymo/dizaino/užduočių
rinkinys, o `AG/spec` — MAŠINAI skirtas scope kontraktas. Sulieti juos reikštų, kad vartas
priklausytų nuo laisvo teksto formatavimo.

Šis katalogas tuščias, kol projektas neturi aktyvaus spec change'o — tada `spec_alignment`
milestone dalis teisingai rodo `skipped`, o ne `ok`.
