# Spec: VERQESTRA backlog v1

## BL-1 — Kiekviena backlog eilutė turi šaltinį

Užduotis įtraukiama tik tada, kai ją galima susieti su audito radiniu, užrašyta atvira riba arba
tikra produkto spraga. Užduotis be šaltinio yra spėjimas, o eilė spėjimų nevykdo.

## BL-2 — Backlog'as generuojamas, ne rašomas

Eilės failai gaminami `verqestra task-generate`. Rankinis failas eilėje leidžiamas tik kaip
išimtis su priežastimi.

## BL-3 — Vartas neuždaromas išgalvota užduotimi

`backlog-audit` kategorija lieka `missing`, jei sričiai nėra tikro darbo. Žalias vartas,
pasiektas raktažodžiais, atima iš audito vienintelę jo vertę.
