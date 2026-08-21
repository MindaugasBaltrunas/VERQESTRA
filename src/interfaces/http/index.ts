// interfaces/http barrel — re-exports only (MOD-1).
// E5 VQ-503 (3/5-a): laisvo teksto redakcija prieš išleidžiant jį į UI.
export * from "./free-text-redaction.js";
// E5 VQ-503 (3/5-b): READ-ONLY bangų vaizdas — kiekvienas šaltinis gniūžta atskirai.
export * from "./ui-waves-view.js";
// E5 VQ-503 (4/5-b): UI porto parinkimas — portas išvedamas iš projekto šaknies, o savu
// pripažįstamas TIK savo projekto serveris.
export * from "./ui-port-rules.js";
export * from "./ui-port-store.js";
// E5 VQ-503 (4/5-c): loop ir UI proceso gyvavimo ciklas — spawn per portą, gyvumas iš runtime
// įrašo (PID + šviežias heartbeat).
export * from "./process-lifecycle-ports.js";
export * from "./loop-lifecycle.js";
export * from "./ui-lifecycle.js";
export * from "./workflow-buckets.js";
// E5 VQ-503 (5/5-a): užduočių įkėlimas ir triažo veiksmai — vieninteliai eilės pakeitimai iš UI.
export * from "./task-upload.js";
export * from "./ui-task-actions.js";
// E5 VQ-503 (5/5-b): agentų aktyvumo SSE srautas — vienas hub'as visai sesijai.
export * from "./sse-service.js";
// E5 VQ-503 (5/5-c): UI serverio saugos riba ir klaidų atvaizdis į HTTP kodus.
export * from "./ui-security.js";
export * from "./ui-error-mapping.js";
// E5 VQ-503 (5/5-d): maršrutizatorius — GRĄŽINA atsakymo aprašą, transportas lieka kompozicijai.
export * from "./ui-router.js";
