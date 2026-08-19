// Lazy `typescript` modulio užkrovimas su cache'uotu promise. Behaviour etalon: AG_loop
// code-index/ts-indexer.ts (design §6): `typescript` yra devDependency — statinis importas
// nužudytų KIEKVIENĄ komandą modulio load metu npm-instaliuotame target'e be jo.

import type * as TypeScriptApi from "typescript";

let typescriptModule: Promise<typeof TypeScriptApi> | undefined;

export async function loadTypeScript(): Promise<typeof TypeScriptApi> {
  typescriptModule ??= import("typescript")
    .then((m) => {
      const withDefault = m as unknown as { default?: typeof TypeScriptApi };
      return withDefault.default ?? m;
    })
    .catch(() => {
      throw new Error(
        "code-index TypeScript analysis requires the `typescript` package. " +
          "Install it in the engine workspace and re-run the code-index build.",
      );
    });
  return await typescriptModule;
}
