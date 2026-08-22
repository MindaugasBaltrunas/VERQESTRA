# Claude Agent Constraints

Šie apribojimai taikomi visiems Claude agentams. Pirmas autoritetas yra projekto `README.md`.

## Niekada neleidžiama

- `rm -rf`, `git reset --hard`, `git clean -fd`, force push.
- Rašymas į `.env`, `.env.*`, `*.pem`, `*.key`, `*.secret` be aiškaus žmogaus patvirtinimo.
- Hardcoded secret, token, slaptažodis ar API raktas.
- Destructive DB veiksmai: drop, truncate, masinis delete/update be patvirtinimo.
- Realios DB migracijos aplikavimas be aiškaus žmogaus patvirtinimo.
- Importų ribų apėjimas tarp izoliuotų modulių ar feature vidinių failų.
- Business logikos perkėlimas į netinkamą sluoksnį vien tam, kad praeitų testas.
- Testų silpninimas vietoje realios klaidos taisymo.

## Reikia aiškaus patvirtinimo

- DB migracijų kūrimas arba keitimas, jei užduotis to aiškiai neapima.
- `package.json` dependencies keitimas.
- Public API arba SDK kontrakto keitimas.
- Auth/RBAC/approval politikos keitimas.
- Failų ar aplankų trynimas/pervadinimas, jei užduotis aiškiai neprašo cleanup.
- Išoriniai network veiksmai, publish, deploy, push arba PR kūrimas.

## TypeScript / kodo kokybė

- TypeScript strict, jei projekte įjungta.
- Jokio naujo `any`, `@ts-ignore` ar flaky testų be aiškaus techninio pagrindimo.
- Public funkcijos ir kontraktai turi būti aiškiai pavadinti ir dokumentuoti, jei jų paskirtis nėra akivaizdi.
- Produkcinis kodas neturi turėti paslėptų side effects.
- Pasenęs, nepasiekiamas arba dubliuojamas kodas šalinamas tik įrodžius, kad jis nenaudojamas arba yra pakeistas aktyviu keliu.

## Testų taisyklės

- Nauji testai turi atitikti projekto esamą testų struktūrą.
- Unit testuose nėra realios DB ar realių HTTP iškvietimų, nebent tai aiškiai integration/e2e testas.
- Jei testas praleidžiamas, ataskaitoje turi būti konkreti priežastis.

## Galutinė ataskaita

```text
Pakeista:
- ...

Ribos:
- Scope: ...
- Neliečiau: ...

Testai:
- ...

Rizikos:
- ...
```