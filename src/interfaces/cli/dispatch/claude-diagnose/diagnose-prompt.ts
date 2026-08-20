// Diagnozės LLM prompt'as (etalono claude-diagnose prompt blokas 1:1 — tekstas yra LLM
// elgesio kontraktas ir nekeičiamas; keliai žinutėse — VERQESTRA vq/* display formos tik
// ten, kur etalonas rodė AG/*). Digest'ai — domain/diagnosis/log-digest per barrel tiltą.

import {
  DIAGNOSIS_DIGEST_LIMITS,
  digestClaudeStreamLog,
  digestQualityGatesLog,
  retryCountsForTask,
} from "../../../../application/task-execution/index.js";
import { DEFAULT_MAX_RETRY_ATTEMPTS } from "../../../../application/task-execution/retry-counts.js";
import { tailLines } from "./diagnose-evidence.js";

export type DiagnosisPromptInput = {
  taskId: string;
  taskText: string;
  claudeExitRaw: string;
  stopOrigin: string;
  stopBlock: string;
  gitStatusText: string;
  gitHead: string;
  commitsSinceStart: string;
  checksTail: string;
  claudeLogOrigin: string;
  claudeLogText: string;
  retryCountsRaw: string;
  previousErrorSignature: string;
  modelSelectionRules: string;
  reduceContext: boolean;
};

export function buildDiagnosisPrompt(input: DiagnosisPromptInput): string {
  // Uodegos eilučių ribos — PIRMAS pjūvis; digest'as iš jo palieka tik sprendimui
  // reikšmingą turinį (domain/diagnosis/log-digest).
  const claudeLogTailLines = input.reduceContext ? 50 : 200;
  const taskExcerptChars = input.reduceContext ? 800 : 2000;
  const claudeLogChars = input.reduceContext ? DIAGNOSIS_DIGEST_LIMITS.claudeLogReduced : DIAGNOSIS_DIGEST_LIMITS.claudeLog;
  const checksChars = input.reduceContext ? DIAGNOSIS_DIGEST_LIMITS.qualityGatesReduced : DIAGNOSIS_DIGEST_LIMITS.qualityGates;

  return `Tu esi AG queue supervisor po Claude darbo pabaigos.

Taisyklės:
- Nekeisk kodo.
- Nerašyk patch.
- Gali skaityti visus šio repo failus ir katalogus, įskaitant produkto kodą, \`.claude/\`, \`AG/\`, dokumentaciją, konfigūraciją ir logus.
- Pirmiausia remkis einama užduotimi, AG logais, Claude hook logais ir quality gates rezultatais.
- Jei Claude darbas baigtas, patikros praėjo ir yra stabilus commit / švari būsena, verdict=done.
- SVARBU: jei "Commits nuo task pradžios" sąrašas netuščias, Claude darbas JAU užcommitintas Stop hook'o — švarus git status TOKIU atveju neįrodo, kad pakeitimų nebuvo. Vertink commit'us ir quality gates; jei gates praėjo, verdict=done. Neverdiktuok "no changes" vien iš švaraus git status.
- Jei Claude Stop machine-readable status yra "error", nelaikyk užduoties done net jei Claude CLI exit code yra 0.
- Jei klaida techninė ir saugu taisyti, verdict=repair.
- Jei ta pati klaida kartojasi arba reikia žmogaus sprendimo, verdict=human_review arba rollback_stop. Palygink dabartinę klaidą su "Paskutinis error_signature (ankstesnio repair bandymo)" žemiau — jei jos iš esmės ta pati, tai yra kartojimasis.
- Repair biudžetas vienam task_id: retry skaitiklio limitas yra ${DEFAULT_MAX_RETRY_ATTEMPTS}, o blokuojamas jau tas bandymas, kuris skaitiklį pakeltų iki limito — realiai įvyksta ne daugiau kaip ${DEFAULT_MAX_RETRY_ATTEMPTS - 1} repair DISPATCH bandymai, tada human-review (ne verdict count, ne total attempts); retry_key yra tik klaidos klasifikacijai ir negali apeiti limito.
- Repair užduotis turi būti trumpa, aiški ir skirta Claude: ką taisyti, kokius logus naudoti, kokias patikras paleisti, kada commitinti ir sustoti.
- Jei verdict=repair, \`claude_repair_task\` privalo būti viena maža taisymo užduotis, o ne kelių darbų sąrašas.
- \`claude_repair_task\` privalo naudoti tik šį formatą:
  \`# Repair Task\`
  \`## Tikslas\`
  \`## Agentas\`
  \`## Klaida\`
  \`## Failai\`
  \`## Veiksmas\`
  \`## Patikra\`
  \`## Stop\`
  \`## Neįtraukta\`
- \`## Failai\` privalo perkelti originalios užduoties \`Leidžiama:\`/\`Draudžiama:\` kelius nepakeistus, o \`## Patikra\` — originalo backtick komandas.
- Neperduok Claude visų logų kaip didelio bloko; nurodyk tik konkrečius failus ir trumpą klaidos esmę.
${input.modelSelectionRules}
- SVARBU: Grąžink TIK JSON objektą be jokių markdown, komentarų ar paaiškinimų. Tiksliai šie laukai:
  {
    "verdict": "done" | "repair" | "human_review" | "rollback_stop",
    "task_id": "<string>",
    "error_signature": "<string>",
    "retry_key": "<string>",
    "selected_model": "haiku" | "sonnet" | "opus",
    "target_agent": "<one agent name>",
    "risk_level": "low" | "medium" | "high",
    "reason": "<string, max 1000 chars>",
    "claude_repair_task": "<string using # Repair Task / ## Tikslas / ## Agentas / ## Klaida / ## Failai / ## Veiksmas / ## Patikra / ## Stop / ## Neįtraukta format>"
  }
  Kai verdict=done, laukai error_signature/retry_key/target_agent/claude_repair_task neturi prasmės — juos gali praleisti arba įrašyti kaip JSON \`null\`; abu variantai priimami tapačiai.

## Task ID
${input.taskId}

## Užduotis (trumpai)
${input.taskText.slice(0, taskExcerptChars)}

## Claude exit code
${input.claudeExitRaw || "unknown"}

## Claude Stop status (source: ${input.stopOrigin})
${input.stopBlock}

## Git status
${input.gitStatusText}

## Git head
${input.gitHead}

## Commits nuo task pradžios (base_head..HEAD)
${input.commitsSinceStart || "(nėra)"}

## Quality gates (klaidoms reikšmingos eilutės)
${digestQualityGatesLog(input.checksTail, checksChars)}

## Claude sesijos santrauka (source: ${input.claudeLogOrigin})
${digestClaudeStreamLog(tailLines(input.claudeLogText, claudeLogTailLines), claudeLogChars)}

## Retry counts (šio task'o)
${retryCountsForTask(input.retryCountsRaw || "{}", input.taskId)}

## Paskutinis error_signature (ankstesnio repair bandymo)
${input.previousErrorSignature.trim() || "(nėra — pirmas bandymas arba anksčiau nebuvo repair)"}
`;
}

/** Stop status bloko tekstas prompt'ui (etalono trinarė šaka 1:1). */
export function renderStopBlock(input: {
  foreign: boolean;
  corrupted: boolean;
  raw: string;
  stopTaskId: string | undefined;
  taskId: string;
}): string {
  if (input.foreign) {
    return `(ignoruota — priklauso kitam task_id "${input.stopTaskId}", ne "${input.taskId}")\n\n${input.raw}`;
  }
  if (input.corrupted) {
    return `(neparsinamas stop įrodymas — laikoma, kad statuso nėra)\n\n${input.raw}`;
  }
  return input.raw;
}
