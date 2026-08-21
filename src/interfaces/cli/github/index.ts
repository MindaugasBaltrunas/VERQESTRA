// interfaces/cli/github barrel — re-exports only (MOD-1).
// E5 VQ-501 (5/5-c): GitHub integracijų komandos — issue-import (draft'as į AG/tasks/pending,
// už gyvavimo ciklo bucket'ų ribų) ir pull-request (trys vartai prieš išorinį veiksmą,
// numatytoji būsena — dry run su įrašytu rezultatu). Politikos vartai ir tinklo klientai
// gyvena infrastructure ir pasiekiami per portus.
export * from "./issue-import.js";
export * from "./pull-request.js";
