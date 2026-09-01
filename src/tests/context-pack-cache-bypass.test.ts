// `--no-context-cache` privalo praleisti VISĄ kešo darbą, ne tik jo rezultatą.
//
// 2026-08-24 operatoriaus radinys: `cacheEnabled` valdė tik `lookup` ir `save`, o šaltinių
// rinkimas su raktų skaičiavimu bėgdavo visada. `collectContextCacheSources` perskaito ir
// suhash'uoja KIEKVIENĄ task'o taikinį, spec šaltinį, architektūros grafą ir politikos failą —
// būtent tą I/O, kurio bypass ir prašoma. Raktas nueidavo tiesiai į šiukšles.
//
// Testas matuoja per portą, o ne per laiką: jei šaltiniai renkami, `collectSources` bus iškviestas.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assembleContextPack } from "../application/context-pack/assemble/assemble.js";
import { buildCodeIndex } from "../application/code-intelligence/indexing/builder.js";
import { createContextCacheAdapter, readContextCacheEntries } from "../infrastructure/persistence/context-cache-store.js";
import { createCodeIntelligenceFsAdapter } from "../infrastructure/fs/code-intelligence-fs-adapter.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import type { ContextCachePort } from "../application/context-pack/ports.js";

const TASK = [
  "# Task",
  "",
  "## Tikslas",
  "Pakeisti demo eksportą.",
  "",
  "## Failai",
  "Leidžiama:",
  "- `src/module/a.ts`",
  "",
  "## Veiksmas",
  "- Pakeisti eksportą.",
  "",
  "## Patikra",
  "- `pnpm test`",
  "",
  "## Stop",
  "Kai žalia.",
  "",
].join("\n");

async function world(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-cache-bypass-"));
  await mkdir(path.join(root, "AG", "tasks", "queue"), { recursive: true });
  await mkdir(path.join(root, "src", "module"), { recursive: true });
  await writeFile(path.join(root, "AG", "tasks", "queue", "0042-demo.md"), TASK, "utf8");
  await writeFile(path.join(root, "src", "module", "a.ts"), 'export function demo(): string {\n  return "x";\n}\n', "utf8");
  await buildCodeIndex(createCodeIntelligenceFsAdapter(root), root);
  return root;
}

type Counts = { collect: number; lookup: number; save: number };

/** Realus adapteris su iškvietimų skaitikliais — elgesys nekeičiamas, tik matuojamas. */
function countingCache(root: string): { port: ContextCachePort; counts: Counts } {
  const inner = createContextCacheAdapter(root, path.join(root, "vq"));
  const counts: Counts = { collect: 0, lookup: 0, save: 0 };
  return {
    counts,
    port: {
      async collectSources(input) {
        counts.collect += 1;
        return await inner.collectSources(input);
      },
      async lookup(key, verifyCodeIndex) {
        counts.lookup += 1;
        return await inner.lookup(key, verifyCodeIndex);
      },
      async save(input) {
        counts.save += 1;
        return await inner.save(input);
      },
    },
  };
}

async function lastCacheStatus(root: string): Promise<string | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(root, "vq", "logs", "context-size.jsonl"));
  const last = (raw ?? "").trim().split("\n").at(-1);
  if (!last) return undefined;
  return (JSON.parse(last) as Record<string, unknown>)["cache_status"] as string | undefined;
}

test("--no-context-cache nerenka šaltinių ir neskaičiuoja rakto", async () => {
  const root = await world();
  try {
    const { port, counts } = countingCache(root);
    const deps = { fs: nodeFsAdapter, codeFs: createCodeIntelligenceFsAdapter(root), cache: port };

    const result = await assembleContextPack(["AG/tasks/queue/0042-demo.md", "--no-context-cache"], root, deps);

    assert.ok(result.outputPath, "bypass NEreiškia, kad pack'as nesurenkamas");
    assert.equal(await lastCacheStatus(root), "bypass");
    assert.deepEqual(counts, { collect: 0, lookup: 0, save: 0 }, "išjungtas kešas neturi liesti nė vieno kešo kelio");
    assert.deepEqual(await readContextCacheEntries(path.join(root, "vq")), [], "bypass nieko nesaugo");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Kontrolė: be vėliavos tas pats portas iškviečiamas. Be jos testas praeitų ir tada, jei kešas
// būtų sugedęs visiems keliams — o tai būtų ne bypass, o regresija.
test("be vėliavos tas pats surinkimas kešo kelią naudoja", async () => {
  const root = await world();
  try {
    const { port, counts } = countingCache(root);
    const deps = { fs: nodeFsAdapter, codeFs: createCodeIntelligenceFsAdapter(root), cache: port };

    await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);

    assert.equal(await lastCacheStatus(root), "miss");
    assert.deepEqual(counts, { collect: 1, lookup: 1, save: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Task 097: `--with-code-graph` renka kandidatus per kitą kelią (`gatherCodeContextCandidates`)
// nei numatytas režimas (`autoGatherCodeContextCandidates`), tad pack'o `code_context` gali
// skirtis tiems patiems taikiniams. Iki pataisos kešo raktas šio skirtumo nematė: abu režimai
// suktų į tą patį fingerprint'ą, ir vienas užrašytas pack'as grįždavo kaip svetimo režimo hit'as.
test("--with-code-graph gauna kitą kešo raktą nei numatytas režimas", async () => {
  const root = await world();
  try {
    const deps = {
      fs: nodeFsAdapter,
      codeFs: createCodeIntelligenceFsAdapter(root),
      cache: createContextCacheAdapter(root, path.join(root, "vq")),
    };

    await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);
    assert.equal(await lastCacheStatus(root), "miss", "pirmas surinkimas numatytu režimu turi būti miss");

    await assembleContextPack(["AG/tasks/queue/0042-demo.md", "--with-code-graph"], root, deps);
    assert.equal(
      await lastCacheStatus(root),
      "miss",
      "grafo režimas neturi gauti numatyto režimo įrašo kaip hit",
    );

    await assembleContextPack(["AG/tasks/queue/0042-demo.md", "--with-code-graph"], root, deps);
    assert.equal(await lastCacheStatus(root), "hit", "tas pats grafo režimas antrą kartą turi hit'inti");

    await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);
    assert.equal(
      await lastCacheStatus(root),
      "hit",
      "numatytas režimas savo anksčiau įrašytą įrašą vis dar randa",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
