// Split vaikų id taisyklės ir idempotentiškas vaikų įėjimas į eilę (etalono
// orchestrator/tasks/task-splitter.ts, VQ-304 3/3). FS/ledger IO — per portus; adapteriai E4.
import { createHash } from "node:crypto";
import path from "node:path";
import { RUNTIME_SEGMENT_MAX_LENGTH } from "../scheduling/worker-limits.js";
import { DEFAULT_TASK_SLUG_MAX_LENGTH, hasLeadingTaskHeading, taskSlug } from "../../domain/tasks/identity.js";
import { taskBucketDir } from "./bucket-transition.js";
import type { TaskDecision } from "./run-coordinator-ports.js";
import type { ChildTaskDraft } from "./task-splitting.js";

// ── Split vaikų id ──────────────────────────────────────────────────────────────────────
//
// Vaiko id KARTU yra runtime kelio segmentas
// (`vq/runtime/runs/<run>/workers/<w>/tasks/<taskId>/attempts/<a>/…`), tad jis privalo tilpti į
// RUNTIME_SEGMENT_MAX_LENGTH. Etalono ankstesnė forma buvo `<PILNAS-tėvo-id>-NN-<slug>`
// (~98 simboliai): ji niekada netilpo į 64, todėl KIEKVIENAS split'o vaikas likdavo BE attempt
// namespace — t. y. be decision/stop įrodymų (2026-08-12 audito radinys #6).
//
// Forma: `<šeimos-bazė>-<kartos-raidės>-<NN>-<trumpas-slug>`, pvz. `1210-a-02-cli-dispatch`.
// Kiekvienas segmentas turi vieną priežastį egzistuoti; nė vienas nėra dekoratyvus:
//
//   * `<šeimos-bazė>` — tėvo šaknies numeris (arba nenumeruoto tėvo slug'as). Po jo VISADA eina
//     `-`, ir tai NĖRA kosmetika: work-evidence git konvencija tėvo įrodymus ieško šablonu
//     `task <numeris>($|[^0-9-])`, kur `-` yra vienintelis sargas nuo vaiko antspaudo.
//     Prilipdyta raidė (`1210a-…`) tą sargą praeitų ir TĖVAS užsidarytų kaip `done` ant savo
//     VAIKO commit'o.
//   * `<kartos-raidės>` — bijektyvinė base-26 vaiko eilė (`a`, `b`, … `z`, `aa`, …), prilipdyta
//     prie tėvo raidžių. Tos pačios kartos broliai skiriasi paskutine raide, gilesnė karta —
//     raidžių ILGIU, tad šeimos šaka lieka atsekama neišlaikant pilno tėvo id.
//   * `-NN-` — kanoninis split-child žymuo, kurį atpažįsta `domain/tasks/identity.ts`
//     (`splitChildParentStemCandidates`). Nuo jo priklauso įrodymų izoliacija: split-child
//     task'ui paliekamas TIK pilno id grep'as, tad vaikas negali užsidaryti ant tėvo ar brolio
//     commit'o. Eilė vienareikšmiškai koduota raidėmis, todėl žymuo lieka dviženklis ir tada,
//     kai vaikų >99.
//   * `<trumpas-slug>` — vaiko pavadinimas, apkirptas iki likusio biudžeto.

/** Vaiko id ilgio riba — importuojama iš runtime namespace kontrakto, o ne perrašoma vietine konstanta. */
const CHILD_TASK_ID_MAX_LENGTH = RUNTIME_SEGMENT_MAX_LENGTH;

/**
 * Unikalaus failo rašymas prie užimto vardo prilipdo `-2` … `-1000`, tad į segmento ribą turi
 * tilpti ir ilgiausia kolizijos forma — kitaip pats kolizijų sprendimas vėl išaugintų id per ribą.
 */
const CHILD_TASK_ID_COLLISION_RESERVE = "-1000".length;

/** Biudžetas, kurį id privalo tenkinti PRIEŠ galimą kolizijos priesagą. */
const CHILD_TASK_ID_BUDGET = CHILD_TASK_ID_MAX_LENGTH - CHILD_TASK_ID_COLLISION_RESERVE;

/** Šeimos bazė kertama, kad slug'ui visada liktų vietos net iš absurdiškai ilgo tėvo id. */
const FAMILY_BASE_MAX_LENGTH = 24;

/** Raidžių uodega, kurią išlaikome; su maxSplitDepth=3 realiai naudojamos 1-3 raidės. */
const FAMILY_LETTERS_MAX_LENGTH = 8;

/** Slug'as niekada nedingsta: be jo id nustotų atitikti `-NN-<suffix>` split-child žymenį. */
const MIN_CHILD_SLUG_LENGTH = 8;

/** Bijektyvinė base-26 eilė: 1 → `a`, 26 → `z`, 27 → `aa`, 28 → `ab`. */
function ordinalLetters(position: number): string {
  let remaining = Math.max(1, Math.trunc(position));
  let letters = "";
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    letters = String.fromCharCode(97 + digit) + letters;
    remaining = Math.trunc((remaining - 1) / 26);
  }
  return letters;
}

type ChildTaskFamily = {
  /** Šaknies numeris arba nenumeruoto tėvo slug'as. */
  base: string;
  /** Tėvo kartos raidės („" — tėvas nėra šios formos vaikas). */
  letters: string;
};

/** Naujos formos vaiko id pradžia: `<bazė>-<raidės>-<NN>-`. */
const SHORT_CHILD_ID_PATTERN = /^([a-z0-9][a-z0-9._]*)-([a-z]+)-\d{2}-/;
const LEADING_TASK_NUMBER_PATTERN = /^(\d+)/;

/**
 * Šeimos tapatybė iš tėvo id. Trys atvejai, sąmoningai šia tvarka:
 * naujos formos vaikas (paveldi bazę IR raides), numeruotas task'as (bazė = numeris) ir
 * nenumeruotas tėvas (bazė = jo slug'as — pvz. `claude-audit-repair`).
 */
function parentTaskFamily(parentTaskId: string): ChildTaskFamily {
  const nested = SHORT_CHILD_ID_PATTERN.exec(parentTaskId);
  if (nested) {
    return { base: nested[1]!.slice(0, FAMILY_BASE_MAX_LENGTH), letters: nested[2]! };
  }
  const numbered = LEADING_TASK_NUMBER_PATTERN.exec(parentTaskId);
  if (numbered) {
    return { base: numbered[1]!.slice(0, FAMILY_BASE_MAX_LENGTH), letters: "" };
  }
  return { base: taskSlug(parentTaskId, FAMILY_BASE_MAX_LENGTH), letters: "" };
}

/**
 * Vaiko task id (failo vardas be `.md`) — deterministinis tėvo id, eilės numerio ir pavadinimo
 * atžvilgiu, ir pagal konstrukciją ≤ {@link CHILD_TASK_ID_BUDGET}: bazė ≤ 24, raidės ≤ 8,
 * žymuo 2, tad prefiksui tenka ≤ 36 iš 59 simbolių ir slug'ui visada lieka ≥ 22.
 *
 * `ordinal` yra tas pats skaičius, kuriuo indeksuojamas child-task ledger'is (`<tėvas>#<ordinal>`)
 * ir kuris prasideda nuo 2, todėl pirmo vaiko raidė yra `a`.
 */
export function childTaskId(parentTaskId: string, ordinal: number, title = "task"): string {
  const family = parentTaskFamily(parentTaskId);
  const letters = `${family.letters}${ordinalLetters(ordinal - 1)}`.slice(-FAMILY_LETTERS_MAX_LENGTH);
  // Žymuo saturuojasi ties 99: `-NN-` pagal identity.ts kontraktą yra DVIŽENKLIS, o tikroji eilė
  // gyvena raidėse, tad trijų skaitmenų „ordinalas" tik sugriautų atpažinimą nieko nepridėjęs.
  const marker = String(Math.min(Math.max(Math.trunc(ordinal), 0), 99)).padStart(2, "0");
  const prefix = `${family.base}-${letters}-${marker}`;
  // `Math.max(MIN_CHILD_SLUG_LENGTH, …)` pagal aukščiau įrodytą aritmetiką nepasiekiamas, bet
  // `taskSlug(title, <=0)` grąžintų tuščią uodegą — tyliai prarastą split-child žymenį.
  const slugBudget = CHILD_TASK_ID_BUDGET - prefix.length - 1;
  // `taskSlug` kerpa PO kraštinių brūkšnelių nuėmimo, tad apkirpimas gali palikti kabantį `-`;
  // nuimame jį čia, kad id baigtųsi prasmingu žodžiu. Tuščias slug'as neįmanomas: `taskSlug`
  // gražina „task", o apkirpta reikšmė prasideda ne brūkšneliu.
  const slug = taskSlug(title, Math.max(MIN_CHILD_SLUG_LENGTH, Math.min(DEFAULT_TASK_SLUG_MAX_LENGTH, slugBudget)))
    .replace(/-+$/, "");
  return `${prefix}-${slug}`;
}

function validChildTask(task: ChildTaskDraft): task is Required<ChildTaskDraft> {
  return Boolean(task.title?.trim() && task.claude_task?.trim());
}

function inheritedSpecSource(decision: TaskDecision): string {
  const task = (decision as { claude_task?: string }).claude_task ?? "";
  const match = task.match(/## Spec source\s*\n([\s\S]*?)(?=\n## |\n# |$)/);
  return match?.[1]?.trim() ?? "";
}

function withInheritedSpecSource(childTask: string, specSource: string): string {
  const trimmed = childTask.trimEnd();
  if (!specSource || /(^|\n)## Spec source\b/.test(trimmed)) {
    return `${trimmed}\n`;
  }

  if (trimmed.startsWith("# Task\n")) {
    return trimmed.replace("# Task\n", `# Task\n\n## Spec source\n${specSource}\n\n`).trimEnd() + "\n";
  }

  return `# Task\n\n## Spec source\n${specSource}\n\n${trimmed}\n`;
}

// Vaikų validacija turi atitikti preflight `hasFatalSectionGap` kontraktą: fatalios tik HARD
// (privalomos) sekcijos. Advisory sekcijas (## Agentai / ## Failai / ## Patikra / ## Neįtraukta)
// normalizuojantis LLM nenuspėjamai numeta (dažniausiai ## Neįtraukta), tad jų trūkumas NEGALI
// nutraukti split'o ir sustabdyti viso loop'o — vaikas vis tiek iš naujo praeina preflight, kur
// SOFT sekcijos netraktuojamos kaip fatalios.
export function missingChildTaskSections(task: string): string[] {
  const missing: string[] = [];
  if (!hasLeadingTaskHeading(task)) missing.push("# Task");
  for (const section of ["## Spec source", "## Tikslas", "## Veiksmas", "## Stop"]) {
    if (!task.includes(section)) missing.push(section);
  }
  return missing;
}

export type InvalidChildTask = {
  title: string;
  missingSections: string[];
};

export type SplitDepthExceeded = {
  parent_depth: number;
  max_depth: number;
};

export type ChildTaskEnqueueOutcome =
  | { ok: true; enqueued: number }
  | { ok: false; invalid: InvalidChildTask[] }
  | { ok: false; depth_exceeded: SplitDepthExceeded };

/** Content-addressed idempotency parašas — tas pats sha256(JSON([parts])) kaip etalono core/task-ledger. */
export function contentSignature(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export type ChildTaskLedgerEntry = {
  signature: string;
  file: string;
  recorded_at: string;
  /** Skaidymo karta (root=0, vaikas=1, jo vaikas=2, ...) — split gylio ribai. Seni įrašai jo neturi. */
  depth?: number;
};

/**
 * Child-task ledger'io (`vq/state/child-task-ledger.json`) ir eilės failų efektai per portą.
 * `writeUniqueTaskFile` privalo išlaikyti etalono `writeUniqueFile` semantiką: užimtas vardas
 * gauna `-2` … `-1000` priesagą prieš `.md`, grąžinamas realiai įrašytas kelias.
 */
export type ChildTaskEnqueuePorts = {
  readLedger(): Promise<Record<string, ChildTaskLedgerEntry>>;
  recordLedgerEntry(key: string, entry: ChildTaskLedgerEntry): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  writeUniqueTaskFile(preferredPath: string, content: string): Promise<string>;
  /** `maxSplitDepth` iš preflight limitų policy (loader — VQ-305; 0 = riba išjungta). */
  maxSplitDepth(): Promise<number>;
  log(message: string): Promise<void>;
  nowIso(): string;
};

// Skaidymo gylis atsekamas per child-task ledger'į, NE per vardo struktūrą: naujoje formoje
// vardas turi lygiai VIENĄ `-NN-` žymenį nepriklausomai nuo kartos (gylį neša raidžių ilgis,
// o jis kertamas ties FAMILY_LETTERS_MAX_LENGTH) — vardas nėra patikimas kartos šaltinis.
// Root task'as ledger'yje nefigūruoja kaip vaikas → gylis 0; seni įrašai be `depth` lauko
// laikomi pirmos kartos vaikais.
async function resolveSplitDepth(ports: ChildTaskEnqueuePorts, taskId: string): Promise<number> {
  const store = await ports.readLedger();
  for (const entry of Object.values(store)) {
    if (taskFileStemOf(entry.file) === taskId) {
      return entry.depth ?? 1;
    }
  }
  return 0;
}

function taskFileStemOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  return base.replace(/\.md$/, "");
}

// Idempotency key: parent task id + child ordinal. Kartu su turinio parašu tai leidžia crash'ą
// tarp vaiko įėjimo ir tėvo bucket perkėlimo atstatyti tiesiog pakartojant tą patį delegate
// žingsnį — jau įrašytas vaikas su nepakitusiu turiniu atpažįstamas ir praleidžiamas, o ne
// kaupia kolizijos priesagą (kuri kiekviename retry tyliai dubliuotų vaiką).
async function ensureChildTaskEnqueued(
  ports: ChildTaskEnqueuePorts,
  taskId: string,
  ordinal: number,
  title: string,
  content: string,
  queueDir: string,
  depth: number,
): Promise<string> {
  const ledgerKey = `${taskId}#${ordinal}`;
  const signature = contentSignature(taskId, String(ordinal), content);

  const store = await ports.readLedger();
  const previous = store[ledgerKey];
  if (previous?.signature === signature && (await ports.exists(previous.file))) {
    return previous.file;
  }

  const written = await ports.writeUniqueTaskFile(path.join(queueDir, `${childTaskId(taskId, ordinal, title)}.md`), content);
  await ports.recordLedgerEntry(ledgerKey, { signature, file: written, recorded_at: ports.nowIso(), depth });
  return written;
}

export async function enqueueChildTasks(
  ports: ChildTaskEnqueuePorts,
  agRoot: string,
  taskId: string,
  decision: TaskDecision,
): Promise<ChildTaskEnqueueOutcome> {
  const childTasks = decision.child_tasks?.filter(validChildTask) ?? [];
  if (childTasks.length === 0) {
    return { ok: true, enqueued: 0 };
  }

  // Gylio vartai PRIEŠ bet kokį rašymą: pasiekus ribą negimsta nė vienas vaikas,
  // tėvą kvietėjas nukreipia į human-review. Kartotinis to paties delegate žingsnio
  // paleidimas grąžina tą patį atsisakymą — idempotentiška kaip ir pats enqueue.
  const maxSplitDepth = await ports.maxSplitDepth();
  const parentDepth = await resolveSplitDepth(ports, taskId);
  const childDepth = parentDepth + 1;
  if (maxSplitDepth > 0 && childDepth > maxSplitDepth) {
    await ports.log(`TASK SPLIT BLOCKED: parent=${taskId} child_depth=${childDepth} max_split_depth=${maxSplitDepth}`);
    return { ok: false, depth_exceeded: { parent_depth: parentDepth, max_depth: maxSplitDepth } };
  }

  const specSource = inheritedSpecSource(decision);
  const prepared = childTasks.map((childTask, index) => ({
    ordinal: index + 2,
    title: childTask.title,
    content: withInheritedSpecSource(childTask.claude_task, specSource),
  }));

  // Validuojamas KIEKVIENAS vaikas PRIEŠ rašant bet kurį iš jų: split'as su vienu nevalidžiu
  // vaiku negali palikti validžiųjų jau eilėje, kol nevalidusis nutraukia visą delegate
  // žingsnį (anksčiau neapdorotas metimas čia palikdavo tėvą įstrigusį „active" su daline
  // vaikų aibe diske).
  const invalid = prepared
    .map((child) => ({ title: child.title, missingSections: missingChildTaskSections(child.content) }))
    .filter((child) => child.missingSections.length > 0);
  if (invalid.length > 0) {
    return { ok: false, invalid };
  }

  const queueDir = taskBucketDir(agRoot, "queue");
  let written = 0;
  for (const child of prepared) {
    await ensureChildTaskEnqueued(ports, taskId, child.ordinal, child.title, child.content, queueDir, childDepth);
    written += 1;
  }

  await ports.log(`TASK SPLIT: parent=${taskId} queued_child_tasks=${written}`);
  return { ok: true, enqueued: written };
}
