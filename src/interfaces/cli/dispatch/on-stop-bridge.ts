// `on-stop-bridge` CLI adapteris (etalonas: interfaces/cli/on-stop-bridge/index.ts).
// Gamina Stop-bridge artefaktus, prieš kuriuos diagnozuoja loop'as. Adapteriui priklauso
// TIK argv parsinimas ir taskId rezoliucija (etalono F7: statusas pririšamas prie šiuo metu
// aktyvaus task'o, kad resume atmestų svetimą pasenusį statusą); pačią rašymo seką daro
// vienintelis no-clobber vartais saugomas rašytojas — infrastructure/state/stop-bridge
// `stopBridgeForProject`, kurį composition paduoda per portą (etalono task 1224: CLI kelias
// gauna KANONINĮ laukų rinkinį su dispatch_nonce ir 2026-08-12 no-clobber vartus).
//
// NEprijungta į Stop hook grandinę: settings registruoja tik `hook-on-stop`. Jei kada būtų
// PRIDĖTA — privalo eiti PO jo: nonce-carrying `done` prieš vartus/commit'ą nužudytų
// sesiją įpusėjus (launcher watchdog).

export type OnStopBridgeCommandDeps = {
  /** Aktyvaus task'o id iš `vq/state/current-task-id`; `""` kai failo nėra. */
  readCurrentTaskId(): Promise<string>;
  /** `stopBridgeForProject` — attempt-first tvarka ir no-clobber vartai gyvena jame. */
  writeStopBridge(status: string, reason: string, taskId: string): Promise<void>;
};

export async function onStopBridge(args: string[], deps: OnStopBridgeCommandDeps): Promise<number> {
  const status = args[0] ?? "unknown";
  const reason = args[1] ?? "";
  const taskId = await deps.readCurrentTaskId();

  await deps.writeStopBridge(status, reason, taskId);
  return 0;
}
