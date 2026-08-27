// `PostToolUse` hook'ai (etalonas: AG_loop hooks/post-hooks.ts) — Bash ir Read pusė; rašymo
// pusė gyvena `post-write.ts`.
//
// VISAS šis failas suprojektuotas NEGALĖTI blokuoti. PostToolUse hook'ui exit 2 yra
// BLOKUOJANTIS kodas, tad kiekviena try/catch riba čia yra saugos sprendimas, o ne stiliaus:
// nė vienas telemetrijos gedimas — sugadintas konfigas, neperskaitomas payload'as, nepavykęs
// log rašymas — neturi teisės sustabdyti įrankio kvietimo. Handleriai grąžina 0 VISADA.

import { isContextCompressionFeatureEnabled } from "../../domain/policies/compression/canary.js";
import type { ContextCompressionConfig } from "../../domain/policies/compression/features.js";
import {
  bashOutputRawText,
  buildBashDigestShadowRecord,
  buildBashReplacementRecord,
  decideBashOutputReplacement,
  digestBashOutput,
  keepForUnreadableHookInput,
  readBashToolResponse,
  unsupportedBashOutputDigest,
  type BashReplacementRecord,
} from "../../domain/tool-results/index.js";
import {
  buildContextSizeMetrics,
  contextSizeMetricsLogPath,
  estimateTokensFromChars,
} from "../../application/context-pack/metrics.js";
import { sha256Hex } from "../../shared/hash.js";
import { appendJsonArrayEntry } from "./session-write-ledger.js";
import {
  consoleHookIo,
  getHookPathField,
  getHookToolName,
  getToolInputField,
  getToolResponse,
  parseHookInput,
  parseHookInputStrict,
  type HookIo,
} from "./protocol.js";
import {
  type PostHookContext,
  type PostHookDeps,
  postHookContext,
  readEventsPath,
  relativeToProject,
  runtimeLogPath,
  runtimeStatePath,
} from "./post-hook-context.js";

/** Sėkmingo PostToolUse hook'o exit kodas. Kitokio šiame faile nėra ir negali būti. */
export const POST_TOOL_OK_EXIT_CODE = 0;

/**
 * PostToolUse hook'o JSON vokas.
 *
 * Tikslią formą nustato įdiegtas Claude Code build'as, ne šis repo — būtent todėl ji gyvena
 * viename tipe ir viename statytojuje: pasikeitus build'ui taisoma vienoje vietoje.
 * WBR VQ-204: envelope yra PROTOKOLAS, tad jo vieta yra interfaces, ne domain.
 */
export type PostToolUseHookOutput = {
  hookSpecificOutput: {
    hookEventName: "PostToolUse";
    updatedToolOutput: Record<string, unknown>;
  };
  /** Neleidžia hook'o stdout patekti į transkriptą — spausdinimas grąžintų ką tik nuimtus tokenus. */
  suppressOutput: true;
};

export function buildPostToolUseHookOutput(updatedToolOutput: Record<string, unknown>): PostToolUseHookOutput {
  return {
    hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput },
    suppressOutput: true,
  };
}

const TELEMETRY_DEPS = { hash: sha256Hex, estimateTokens: estimateTokensFromChars };

/** Kompresijos konfigas arba `undefined`; klaida čia — „funkcija išjungta", niekada ne blokas. */
async function compressionConfig(context: PostHookContext): Promise<ContextCompressionConfig | undefined> {
  return await context.deps.ports.loadCompressionConfig(context.runtimeRoot).catch(() => undefined);
}

function digestFeatureEnabled(config: ContextCompressionConfig | undefined): boolean {
  return config !== undefined && isContextCompressionFeatureEnabled(config, "bash_output_digest");
}

export async function hookPostBash(deps: PostHookDeps): Promise<number> {
  const context = postHookContext(deps);
  const input = parseHookInput(await context.deps.ports.stdin.readStdin());
  const command = getToolInputField(input, "command");
  await context.log(`post-bash: ${command}`);
  await recordBashDigestShadow(context, command, input);
  return POST_TOOL_OK_EXIT_CODE;
}

/**
 * `task_id`, kuriam priskirti šio Bash kvietimo shadow matavimą, arba `""`, kai jis
 * nepasiekiamas.
 *
 * Ta pati tapatybės grandinė kaip {@link resolveWriterIdentity} `post-write.ts` faile:
 * `current-task-id` yra VIENAS globalus failas, kurį mato visos to paties darbo medžio
 * sesijos. Be `AG_DISPATCH_NONCE` patikros interaktyvi sesija priskirtų savo Bash kvietimus
 * tam task'ui, kurį tuo metu vykdo VISIŠKAI kita (dispatch'inta) sesija — būtent tą
 * susimaišymą nonce patikra ir užkerta.
 */
async function resolveShadowTaskId(context: PostHookContext): Promise<string> {
  const nonce = (context.deps.ports.env("AG_DISPATCH_NONCE") ?? "").trim();
  if (!nonce) return "";
  const taskId = await context.deps.ports.fs.readTextFileIfExists(runtimeStatePath(context, "current-task-id"));
  return (taskId ?? "").trim();
}

/**
 * Bash išvesties digest'o SHADOW matavimas (etalono task 0026; task 0036 prideda
 * `tool_raw_chars`/`tool_digest_chars` porą į `context-size.jsonl`).
 *
 * Šis hook'as lieka stebėtoju: jis nieko nespausdina, negrąžina `updatedToolOutput` ir todėl
 * negali pakeisti nė vieno simbolio rezultato, kurį mato darbuotojas. Vienintelis efektas —
 * viena JSONL eilutė per Bash kvietimą, fiksuojanti, kiek digest'as BŪTŲ kainavęs ir sutaupęs,
 * ir (kai `task_id` žinomas) antra eilutė bendrame `context-size.jsonl`, kad ta pati pora
 * patektų į A/B palyginimą šalia kitų kompresijos vėliavų.
 *
 * Išjungta vėliava yra tikras no-op: patikra įvyksta PRIEŠ paliečiant payload'ą. Kiekvienas
 * gedimas (neperskaitomas konfigas ar payload'as, defektas variklyje) degraduoja į „nėra
 * telemetrijos" — matavimas niekada negali sulaužyti to, ką matuoja.
 */
async function recordBashDigestShadow(
  context: PostHookContext,
  command: string,
  input: Record<string, unknown>,
): Promise<void> {
  try {
    if (!digestFeatureEnabled(await compressionConfig(context))) return;

    const reading = readBashToolResponse(getToolResponse(input));
    const digest = reading.ok
      ? digestBashOutput({ command, response: reading.value })
      : unsupportedBashOutputDigest(command, `unreadable tool_response: ${reading.reason}`);
    const rawText = reading.ok ? bashOutputRawText(reading.value) : "";

    const record = buildBashDigestShadowRecord({ digest, rawText, now: context.now() }, TELEMETRY_DEPS);
    await context.deps.ports.fs.appendTextFile(
      runtimeLogPath(context, "bash-digest-shadow.jsonl"),
      `${JSON.stringify(record)}\n`,
    );

    // Be `task_id` šis įrašas negalėtų prisijungti prie jokio kito matavimo tam pačiam
    // bandymui, o pakaitinis identifikatorius (session id ir pan.) tik apsimestų task'u —
    // tad tokiu atveju eilutė tiesiog nerašoma, ne pakeičiama nesaugiu spėjimu.
    const taskId = await resolveShadowTaskId(context);
    if (taskId) {
      const sizeRecord = buildContextSizeMetrics(
        {
          taskId,
          contextChars: 0,
          maxContextChars: 0,
          specFragmentCount: 0,
          codeContextItemCount: 0,
          toolRawChars: record.raw_chars,
          toolDigestChars: record.digest_chars,
        },
        context.now(),
      );
      await context.deps.ports.fs.appendTextFile(
        contextSizeMetricsLogPath(context.runtimeRoot),
        `${JSON.stringify(sizeRecord)}\n`,
      );
    }
  } catch {
    // Shadow telemetrija yra best-effort pagal kontraktą: sugadintas kompresijos konfigas,
    // netikėtas payload'as ar nepavykęs log rašymas neturi paversti PostToolUse hook'o
    // užblokuotu tool call'u.
  }
}

export type PostBashSyncOutcome = {
  /** Hook JSON, kurį reikia spausdinti. Nėra = „neturiu nuomonės": lieka originalus rezultatas. */
  hookOutput?: PostToolUseHookOutput;
  /** Įrodymo eilutė, patenkanti į replacement žurnalą; nėra, kai funkcija išjungta. */
  record?: BashReplacementRecord;
};

/**
 * Sinchroninis PostToolUse Bash kelias (etalono task 0027) — SPRENDIMO pusė kaip gryna funkcija.
 *
 * Atskirta nuo {@link hookPostBashSync} sąmoningai: viskas, ką verta testuoti (kurie payload'ai
 * gali būti perrašyti, ką neša vokas, ką fiksuoja žurnalas), sprendžiama čia iš eilutės, tad nė
 * vienam testui nereikia perimti proceso stdin/stdout.
 *
 * Fail-safe visomis kryptimis: vėliava skaitoma PRIEŠ payload'ą, tad `bash_output_digest=false`
 * yra tikras no-op, o neperskaitomas konfigas, neperskaitomas payload'as ar defektas žemiau
 * degraduoja į „jokios išvesties, originalas lieka". Hook'as, galintis perrašyti rezultatą,
 * niekada neturi galėti padaryti tool call'o blogesnio nei visai nepaleistas.
 */
export async function evaluatePostBashSync(deps: PostHookDeps, rawStdin: string): Promise<PostBashSyncOutcome> {
  const context = postHookContext(deps);
  try {
    if (!digestFeatureEnabled(await compressionConfig(context))) return {};

    const parsed = parseHookInputStrict(rawStdin);
    const decision = parsed.ok
      ? decideBashOutputReplacement({
          toolName: getHookToolName(parsed.value),
          command: getToolInputField(parsed.value, "command"),
          toolResponse: getToolResponse(parsed.value),
        })
      : // KIND, niekada `parsed.error`: parserio žinutė įterpia įvesties, ant kurios užspringo,
        // fragmentą — čia tai komandos eilutė ir jos išvestis — o šis sprendimas rašomas į
        // žurnalą, kurio visas kontraktas yra tas, kad jis neneša nei vieno, nei kito.
        keepForUnreadableHookInput(parsed.kind);

    // Hash'uojama tik tada, kai sprendimas realiai skaitė payload'ą; kitaip įrašas suporuotų
    // `original_chars: 0` su realaus teksto hash'u ir skambėtų prieštaringai.
    const rawText =
      parsed.ok && decision.payloadShape !== "unreadable" ? rawTextOf(getToolResponse(parsed.value)) : "";

    const record = buildBashReplacementRecord({ decision, rawText, now: context.now() }, TELEMETRY_DEPS);
    await context.deps.ports.fs.appendTextFile(
      runtimeLogPath(context, "bash-digest-replacement.jsonl"),
      `${JSON.stringify(record)}\n`,
    );

    return {
      ...(decision.action === "replace"
        ? { hookOutput: buildPostToolUseHookOutput(decision.replacement.updatedToolOutput) }
        : {}),
      record,
    };
  } catch {
    // Originalo išsaugojimas visada yra galiojantis atsakymas, tad kiekvienas gedimas krenta
    // į jį, o ne į užblokuotą arba pusiau perrašytą tool call'ą.
    return {};
  }
}

/**
 * Plonas srautų adapteris aplink {@link evaluatePostBashSync}.
 *
 * Spausdina lygiai vieną hook JSON eilutę, kai perrašymas įrodytas, ir NIEKO kitu atveju:
 * tuščia išvestis yra vienareikšmis „šis hook'as neturi nuomonės" signalas, o tuščias JSON
 * objektas — dar vienas dalykas, kurį Claude Code build'as turi interpretuoti.
 *
 * try/catch apima ir srautų kvietimus, ne tik sprendimą: nepavykęs stdin skaitymas ar EPIPE
 * kitaip paverstų „neturiu nuomonės" užblokuotu tool call'u.
 */
export async function hookPostBashSync(deps: PostHookDeps): Promise<number> {
  const io: HookIo = deps.io ?? consoleHookIo;
  try {
    const outcome = await evaluatePostBashSync(deps, await deps.ports.stdin.readStdin());
    if (outcome.hookOutput) {
      io.out(JSON.stringify(outcome.hookOutput));
    }
  } catch {
    // Tyla yra saugus atsakymas: lieka originali įrankio išvestis.
  }
  return POST_TOOL_OK_EXIT_CODE;
}

/** Tekstas, prieš kurį buvo priimtas sprendimas, arba "" kai payload'as neperskaitomas. */
function rawTextOf(toolResponse: unknown): string {
  const reading = readBashToolResponse(toolResponse);
  return reading.ok ? bashOutputRawText(reading.value) : "";
}

/**
 * Read įrodymo užrašymas readme-guard vartams.
 *
 * Lock timeout politika čia APVERSTA lyginant su ledger'iu: prarastas readme įrašas uždaro
 * vartus grandinės viduryje, o agentas jų atidaryti nebegali (šio failo rašymas per įrankius
 * uždraustas), tad po deadline'o vis tiek rašoma — bet atominiu rename, tad fail-closed
 * skaitytojas (`pre-hooks`) niekada nemato apkirpto JSON.
 */
export async function hookPostRead(deps: PostHookDeps): Promise<number> {
  const context = postHookContext(deps);
  const input = parseHookInput(await context.deps.ports.stdin.readStdin());
  const filePath = relativeToProject(context, getHookPathField(input));
  if (!filePath) {
    return POST_TOOL_OK_EXIT_CODE;
  }

  // Trumpesnis deadline nei ledger'io: Read yra dažniausias tool call'as, o šio failo politika
  // vis tiek fail-open — laukti pilnų 15 s KIEKVIENAME Read'e degradavusioje FS reikštų sesiją,
  // kuri stovi vietoje. Praradimo rizikos tai nedidina: po deadline'o įrašas vis tiek rašomas.
  const append = await appendJsonArrayEntry(context.deps.ports.fs, readEventsPath(context), filePath, {
    lockWaitMs: deps.readEventLockWaitMs ?? READ_EVENT_LOCK_WAIT_MS,
    onLockTimeout: "unlocked-append",
  });

  if (!append.appended) {
    // Vienintelis kelias, kuriame readme įrodymas realiai prarandamas — jis privalo būti
    // grep'inamas, nes toliau grandinėje pasirodo kaip „pre-write vartai uždaryti".
    await context.log(
      `readme-read-events: read_event_append_failed=1 path=${filePath} ` +
        `waited_ms=${append.waitedMs} reason=${append.failure ?? "unknown"}`,
    );
  } else if (append.degraded) {
    await context.log(
      `readme-read-events: read_event_unlocked_append=1 path=${filePath} waited_ms=${append.waitedMs}`,
    );
  }

  await context.log(`post-read: ${filePath}`);
  return POST_TOOL_OK_EXIT_CODE;
}

/** Read įrodymo lock deadline. Trumpesnis nei ledger'io — žr. {@link hookPostRead}. */
export const READ_EVENT_LOCK_WAIT_MS = 5_000;
