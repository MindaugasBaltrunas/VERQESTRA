// Bendras fake pasaulis VQ-502 (5/6-c) PostToolUse testams: in-memory FS su ledger'io
// primityvais, stdin, git status atsakymai, env ir laikrodis. Vienoje vietoje, nes Bash/Read ir
// rašymo testai naudoja tuos pačius portus.

import type { ContextCompressionConfig } from "../../domain/policies/compression/features.js";
import type {
  PostHookPorts,
  PostHookProcessResult,
} from "../../interfaces/hooks/post-hook-context.js";
import type { HookIo } from "../../interfaces/hooks/protocol.js";

export type PostHookWorld = {
  ports: PostHookPorts;
  io: HookIo;
  out: string[];
  err: string[];
  store: Map<string, string>;
  env: Map<string, string>;
  faults: { append?: Error; write?: Error };
  /** Keliai, kurių atominis rašymas meta — sidecar'o gedimui atskirti nuo ledger'io gedimo. */
  writeFailPaths: Set<string>;
  /** `git status` atsakymai pagal repo-santykinį kelią; nėra įrašo — kodas 0 ir tuščia eilutė. */
  gitStatus: Map<string, PostHookProcessResult>;
  gitCalls: string[];
};

export type PostHookWorldInput = {
  stdin?: string;
  files?: Record<string, string>;
  config?: ContextCompressionConfig;
  env?: Record<string, string>;
  now?: Date;
};

export function fakePostHookWorld(input: PostHookWorldInput = {}): PostHookWorld {
  const store = new Map(Object.entries(input.files ?? {}));
  const out: string[] = [];
  const err: string[] = [];
  const world: PostHookWorld = {
    out,
    err,
    store,
    env: new Map(Object.entries(input.env ?? {})),
    faults: {},
    writeFailPaths: new Set<string>(),
    gitStatus: new Map(),
    gitCalls: [],
    io: { out: (line) => out.push(line), error: (line) => err.push(line) },
    ports: {
      fs: {
        exists: async (p) => store.has(p),
        makeDirectory: async () => {},
        readTextFileIfExists: async (p) => store.get(p),
        readContendedTextFileIfExists: async (p) => store.get(p),
        writeTextFile: async (p, content) => {
          if (world.faults.write) throw world.faults.write;
          if (world.writeFailPaths.has(p)) throw new Error(`EPERM ${p}`);
          store.set(p, content);
        },
        appendTextFile: async (p, text) => {
          if (world.faults.append) throw world.faults.append;
          store.set(p, `${store.get(p) ?? ""}${text}`);
        },
        writeFileExclusive: async (p, content) => {
          if (store.has(p)) return "exists";
          store.set(p, content);
          return "created";
        },
        renamePath: async (from, to) => {
          const value = store.get(from);
          if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          store.delete(from);
          store.set(to, value);
        },
        removeFile: async (p) => void store.delete(p),
        // Šviežias mtime: testuose lock'as niekada netampa stale savaime — stale kelias
        // pin'inamas atskirai `interfaces-hooks-ledger-lock` testuose.
        fileMtimeMs: async (p) => (store.has(p) ? Date.now() : undefined),
      },
      stdin: { readStdin: async () => input.stdin ?? "{}" },
      loadCompressionConfig: async () => input.config,
      gitStatusForPath: async (_projectRoot, relativePath) => {
        world.gitCalls.push(relativePath);
        return world.gitStatus.get(relativePath) ?? { code: 0, stdout: "" };
      },
      env: (name) => world.env.get(name),
      ...(input.now === undefined ? {} : { now: () => input.now as Date }),
    },
  };
  return world;
}
