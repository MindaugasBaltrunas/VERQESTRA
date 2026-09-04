// `accept-scope` CLI adapteris (158-a-02, po 158 grynojo domain redaktoriaus). Uždaro
// human-review `rollback_failed` parką be requeue: žmogus jau patvirtino, kad palikti keliai
// priklauso task'o scope'ui, komanda juos įrašo į `## Failai` per `acceptScopePaths` ir perkelia
// failą tiesiai į `done` — jokio ledger clear ar biudžeto reset, nes darbas jau baigtas žaliai.

import path from "node:path";
import { acceptScopePaths } from "../../../domain/tasks/failai-scope-edit.js";
import { resolveProjectPath, toPosixPath } from "../../../shared/paths.js";
import { moveTaskToBucket, type TaskStateStorePort } from "../../../application/task-execution/bucket-transition.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type AcceptScopeCommandDeps = {
  store: TaskStateStorePort;
  readTextFile(absolutePath: string): Promise<string>;
  writeTextFile(absolutePath: string, text: string): Promise<void>;
  /** `true` kai kelias egzistuoja ir yra failas (etalono stat().isFile() patikra). */
  isFile(absolutePath: string): Promise<boolean>;
  projectRoot: string;
  io?: CliIo;
  nowIso?: () => string;
};

export async function acceptScope(args: string[], deps: AcceptScopeCommandDeps): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const [taskArg, ...pathArgs] = args;

  if (!taskArg || pathArgs.length === 0) {
    io.error("Usage: verqestra accept-scope <task-file-or-name> <path...>");
    return 2;
  }

  const root = path.resolve(deps.projectRoot);
  const agRoot = path.join(root, "AG");
  const taskName = taskArg.endsWith(".md") ? path.basename(taskArg) : `${taskArg}.md`;
  const source = path.join(agRoot, "tasks", "human-review", taskName);

  if (!(await deps.isFile(source))) {
    io.error(`Not found in human-review: ${taskName}`);
    return 2;
  }

  const relativePaths: string[] = [];
  for (const pathArg of pathArgs) {
    let absolute: string;
    try {
      absolute = resolveProjectPath(root, pathArg, {}, "accept-scope path");
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
    if (!(await deps.isFile(absolute))) {
      io.error(`accept-scope path not found: ${pathArg}`);
      return 2;
    }
    relativePaths.push(toPosixPath(path.relative(root, absolute)));
  }

  const text = await deps.readTextFile(source);
  const nowIso = deps.nowIso?.() ?? new Date().toISOString();
  const note = `${nowIso.slice(0, 10)}: accept-scope patvirtinta (žmogaus peržiūra, be requeue)`;
  const edited = acceptScopePaths(text, relativePaths, note);
  if (!edited.ok) {
    io.error(edited.error.message);
    return 2;
  }

  await deps.writeTextFile(source, edited.value);
  await moveTaskToBucket(deps.store, agRoot, source, "done", taskName, { updateCurrent: false });

  io.out(`accepted: ${taskName} paths=${relativePaths.length}`);
  return 0;
}
