// VIENINTELIS įėjimo taškas (LAY-2). Verslo logikos čia nėra: komandos surišamos
// `src/composition/*`, o šis failas tik paverčia grąžintą kodą proceso baigtimi.
//
// `process.exitCode`, o ne `process.exit()`: pastarasis nutrauktų dar nebaigtus stdout rašymus, ir
// paskutinė komandos eilutė kartais dingtų iš pipe'o.

import { runCliFromEnv } from "./composition/cli/main.js";

process.exitCode = await runCliFromEnv(process.argv.slice(2));
