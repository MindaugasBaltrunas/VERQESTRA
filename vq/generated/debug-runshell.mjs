import { runShell } from "../../dist/infrastructure/process/run-process.js";

const result = await runShell('node -e "process.exit(1)"', process.cwd());
console.log(JSON.stringify(result, null, 2));
