# System Repair Task

System task metadata:
- kind: system-repair
- reason: final-quality-audit

## Tikslas
Visos queue užduotys baigtos. Quality gates nepraėjo galutinio audito metu. Pataisyk klaidas.

## Agentas
debugger

## Klaida
Perskaityk: vq/logs/checks-last.log

## Veiksmas
- Rask klaidas iš checks-last.log.
- Pataisyk technines klaidas (TypeScript, lint, testų klaidos).
- Nekeisk produkto logikos ir API.

## Patikra
Paleisk verqestra quality-gates arba komandas iš vq/config/quality-policy.json.

## Stop
Kai patikros praeina arba SKIP yra pagrįstas, įrašyk commit žinutę į vq/logs/commit-msg.md ir sustok.

## Neįtraukta
Architektūros pakeitimai, naujas funkcionalumas, DB migracijos.
