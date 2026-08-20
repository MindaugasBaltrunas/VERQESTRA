// OpenSpec change generavimas projekto implementacijai PRIEŠ queue sintezę: README
// produkto intencija + architektūros grafas → sintetinis task tekstas → generatorius.
// Elgesio etalonas: AG_loop application/project-bootstrap/generate.ts. VERQESTRA
// skirtumai: README intencijos parseris, architektūros bootstrap'as, grafo skaitymas ir
// LLM generatorius ateina per BootstrapSpecPorts (realus generatorius leidžia headless
// LLM — E4/E5; testai paduoda stub'ą, kaip ir etalone).

import path from "node:path";
import type { ArchitectureGraph } from "../../domain/architecture/graph.js";

/** README produkto intencijos sekcija — porto kontraktas (etalono readme-intent forma). */
export type ProductIntentSection = {
  heading?: string;
  level: number;
  bullets: string[];
  paragraphs: string[];
};

export type ProductIntent = {
  kind: "intent";
  title?: string;
  sections: ProductIntentSection[];
};

export type ProductIntentResult = ProductIntent | { kind: "no-intent"; reason: "readme-missing" | "readme-empty" };

/**
 * OpenSpec change generatoriaus parašas. Atitinka etalono `generateOpenSpecChange`
 * (naudojamas kaip biblioteka). Injektuojamas, kad testai niekada nekviestų headless
 * Claude — realus generatorius leidžia LLM.
 */
export type OpenSpecChangeGenerator = (
  taskText: string,
  taskId: string,
  agRoot: string,
  model: string,
) => Promise<string | null>;

export type BootstrapSpecPorts = {
  /** README produkto intencijos parseris (etalono readme-intent). */
  loadReadmeProductIntent(projectRoot: string): Promise<ProductIntentResult>;
  /** Idempotentiškas grafo atnaujinimas iš .mmd šaltinio (done-status išsaugomas). */
  refreshArchitectureFromSource(projectRoot: string): Promise<void>;
  /** Importuotas grafas arba `null`, kai jo nėra. */
  readArchitectureGraph(absolutePath: string): Promise<ArchitectureGraph | null>;
  generateChange: OpenSpecChangeGenerator;
  /** Absoliutūs `.md` failai change kataloge; `[]` kai katalogo nėra. */
  listMarkdownFiles(absoluteDir: string): Promise<string[]>;
};

export type BootstrapOpenSpecResult =
  /** README nėra/tuščias arba be produkto intencijos turinio — signalas, ne fabrikacija. */
  | { status: "insufficient-evidence"; reason: string }
  /** README intencija buvo, bet generatorius nepagamino naudingo change. */
  | { status: "generation-failed"; reason: string }
  /** OpenSpec change sukurtas ar atnaujintas; neša id + failų kelius queue sintezei. */
  | { status: "generated"; changeId: string; changeRef: string; files: string[] };

/** taskId, paduodamas generatoriui; auto- slug'as vedamas iš README pavadinimo, ne iš šio. */
const BOOTSTRAP_TASK_ID = "bootstrap-project-implementation";

/** Ar README davė bent vieną bullet ar paragrafą bet kur. */
function hasIntentContent(intent: ProductIntent): boolean {
  return intent.sections.some((s) => s.bullets.length > 0 || s.paragraphs.length > 0);
}

/**
 * Atrenderina parsintą README intenciją atgal į kompaktišką markdown bloką. Pirmo lygio
 * (title) antraštė praleidžiama (ji tampa task pavadinimu), bet jos bullets/paragrafai
 * lieka, tad index-stiliaus README, kabinantys visą turinį po title, neprarandami.
 */
function renderProductIntent(intent: ProductIntent): string {
  const lines: string[] = [];
  for (const section of intent.sections) {
    if (section.heading && section.level !== 1) {
      lines.push(`### ${section.heading}`);
    }
    for (const bullet of section.bullets) {
      lines.push(`- ${bullet}`);
    }
    for (const paragraph of section.paragraphs) {
      lines.push(paragraph);
    }
  }
  return lines.join("\n").slice(0, 4000);
}

/** Atrenderina importuotą architektūros grafą kaip komponentus + ryšius spec generatoriui. */
function renderArchitectureGraph(graph: ArchitectureGraph): string {
  const nodes = graph.nodes.map((n) => `- ${n.id}: ${n.label}`).join("\n");
  const edges = graph.edges
    .map((e) => `- ${e.from} -> ${e.to}${e.label ? ` (${e.label})` : ""}`)
    .join("\n");
  return `### Komponentai\n${nodes || "- (nėra)"}\n\n### Ryšiai\n${edges || "- (nėra)"}`;
}

/**
 * Sukomponuoja sintetinį project-implementation task tekstą TIK iš README intencijos ir
 * architektūros grafo. Jokio turinio už šių dviejų įrodymų šaltinių ribų.
 */
function composeSpecTaskText(intent: ProductIntent, graph: ArchitectureGraph | null): string {
  const title = intent.title ?? "Project Implementation";
  const hasGraph = graph !== null;
  return `# Project Implementation: ${title}

## Spec source
README.md${hasGraph ? " + AG/architecture graph" : ""}

## Tikslas
Sudaryk OpenSpec change, aprašantį projekto implementaciją pagal README produkto intenciją${
    hasGraph ? " ir architektūros grafą" : ""
  }. Remkis TIK žemiau pateiktais įrodymais; nefabrikuok reikalavimų už README/.mmd ribų.

## README produkto intencija
${renderProductIntent(intent)}

## Architektūros grafas
${hasGraph ? renderArchitectureGraph(graph) : "Nėra importuoto architektūros grafo (.mmd)."}

## Veiksmas
- Aprašyk implementacijos scope, ribas ir acceptance criteria remdamasis tik README intencija ir architektūros grafu.
`;
}

/**
 * Sugeneruoja arba atnaujina OpenSpec change, aprašantį projekto implementaciją, iš README
 * produkto intencijos + architektūros grafo, deleguodamas patį change autorystės darbą
 * portu paduotam generatoriui.
 *
 * Įrodymų disciplina (spec: „Human review for weak evidence"): jei README nėra, tuščias
 * arba be intencijos turinio — grąžinamas `insufficient-evidence` signalas, o ne
 * išgalvoti reikalavimai. Generatorius rašo į `auto-` prefikso change slug'ą, tad
 * pakartotinis paleidimas atnaujina tą patį change ir niekada neperrašo ranka autorinto.
 */
export async function generateProjectImplementationSpec(
  ports: BootstrapSpecPorts,
  projectRoot: string,
  agRoot: string,
  model: string,
): Promise<BootstrapOpenSpecResult> {
  const root = path.resolve(projectRoot);

  const intentResult = await ports.loadReadmeProductIntent(root);
  if (intentResult.kind === "no-intent") {
    return {
      status: "insufficient-evidence",
      reason:
        intentResult.reason === "readme-missing"
          ? "README.md is missing — no product intent to bootstrap from."
          : "README.md is empty — no product intent to bootstrap from.",
    };
  }
  if (!hasIntentContent(intentResult)) {
    return {
      status: "insufficient-evidence",
      reason: "README.md has no product-intent content (no bullets or paragraphs).",
    };
  }

  // Grafas atnaujinamas iš bet kurio .mmd šaltinio (idempotentiška), tada skaitomas.
  // Architektūra padeda, bet neprivaloma — intencijos source of truth yra README.
  await ports.refreshArchitectureFromSource(root);
  const graph = await ports.readArchitectureGraph(path.join(root, "vq", "state", "architecture", "graph.json"));

  const taskText = composeSpecTaskText(intentResult, graph);
  const changeRef = await ports.generateChange(taskText, BOOTSTRAP_TASK_ID, agRoot, model);
  if (!changeRef) {
    return {
      status: "generation-failed",
      reason: "OpenSpec generator returned no change; not fabricating a spec.",
    };
  }

  const changeId = changeRef.split("/").filter(Boolean).pop() ?? "";
  const changeDir = path.join(agRoot, "openspec", "changes", changeId);
  const absoluteFiles = await ports.listMarkdownFiles(changeDir);
  if (absoluteFiles.length === 0) {
    return {
      status: "generation-failed",
      reason: `OpenSpec change ${changeRef} reported success but no files were written.`,
    };
  }

  const files = absoluteFiles.map((file) => path.relative(root, file).replace(/\\/g, "/"));
  return { status: "generated", changeId, changeRef, files };
}
