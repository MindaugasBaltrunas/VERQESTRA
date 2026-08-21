// interfaces/http barrel — re-exports only (MOD-1).
// E5 VQ-503 (3/5-a): laisvo teksto redakcija prieš išleidžiant jį į UI.
export * from "./free-text-redaction.js";
// E5 VQ-503 (3/5-b): READ-ONLY bangų vaizdas — kiekvienas šaltinis gniūžta atskirai.
export * from "./ui-waves-view.js";
// E5 VQ-503 (4/5-b): UI porto parinkimas — portas išvedamas iš projekto šaknies, o savu
// pripažįstamas TIK savo projekto serveris.
export * from "./ui-port-rules.js";
export * from "./ui-port-store.js";
