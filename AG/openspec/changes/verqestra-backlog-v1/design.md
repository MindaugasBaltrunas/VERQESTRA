# Design: VERQESTRA backlog v1

Backlog'as generuojamas per patį produktą (`verqestra task-generate --change
verqestra-backlog-v1`), o ne rašomas ranka. Priežastis ta pati, dėl kurios VQ-702 buvo vertas
gyvo paleidimo: kelias, kuriuo niekas nėjo, nėra patikrintas kelias.

Kiekviena `tasks.md` eilutė virsta `AG/tasks/queue/NNNN-<slug>.md` failu su numatytais
agentais, leidžiamais keliais ir patikromis. Numeracija imama nuo cross-bucket maksimumo, tad
pakartotinis paleidimas kolizijų negamina.

Prioritetas nėra šio dokumento dalykas: eilės tvarką sprendžia operatorius, o `task-dependencies`
– blokavimus.
