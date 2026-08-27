#!/usr/bin/env node
// VIENINTELIS įėjimo taškas (LAY-2). Verslo logikos čia nėra: komandos surišamos
// Shebang PRIVALOMAS (2026-08-27, GeoGravity incidentas): npm cmd-shim skaito bin taikinio
// pirmą eilutę — be shebang jis generuoja shim'ą, kuris vykdo cli.js TIESIOGIAI kaip shell
// skriptą (`exec ".../cli.js"` be node), ir kiekvienas hook target projekte lūžta ties
// pirmu komentaru. Repo viduje spraga nematoma, nes vidiniai keliai kviečia `node ...`.
// `src/composition/*`, o šis failas tik paverčia grąžintą kodą proceso baigtimi.
//
// `process.exitCode`, o ne `process.exit()`: pastarasis nutrauktų dar nebaigtus stdout rašymus, ir
// paskutinė komandos eilutė kartais dingtų iš pipe'o.

import { runCliFromEnv } from "./composition/cli/main.js";

process.exitCode = await runCliFromEnv(process.argv.slice(2));
