// Bash tool komandų politika — grynos allowlist/denylist taisyklės (etalono policy/bash-policy.ts,
// WBR VQ-305). Vartotojai: hooks pre-bash gate (E5) ir quality-gates shell komandų kelias.
//
// VERQESTRA layout adaptacija: saugomi runtime keliai papildyti `vq/state` ir `vq/supervisor`
// formomis (etalone tie artefaktai gyveno `AG/state`/`AG/supervisor`; senosios formos paliktos,
// kad politika liktų griežtesnė, o ne siauresnė). Task bucket'ų keliai (`AG/tasks/...`) lieka
// nepakitę — bucket'ai VERQESTRA'oje gyvena ten pat.
import {
  EMPTY_CHECK_COMMAND_CONTEXT,
  isAllowedCheckSegment,
  type CheckCommandContext,
} from "./check-command-allowlist.js";

const sensitivePatterns = [
  "npm install",
  "npm uninstall",
  "git commit",
  "git merge",
  "git rebase",
  "psql",
  "mysql",
];

function escapeRegex(s: string): string {
  return s.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}

const sensitiveRegex = new RegExp(sensitivePatterns.map(escapeRegex).join("|"), "i");
const generatedHookRuntimeRegex =
  /\b(?:AG[\\/]+orchestrator[\\/]+dist(?:[\\/]|$)|dist[\\/]+cli\.js\b)/i;
const protectedOrchestratorStateRegex =
  /\b(?:(?:AG|vq)[\\/]+state[\\/]+|(?:AG|vq)[\\/]+supervisor[\\/]+(?:decision\.json|reformulated-task\.md|repair-task\.md))\b/i;
const readmeGuardEvidenceRegex =
  /\b(?:logs[\\/]+\.readme-guard-ok|(?:AG|vq)[\\/]+state[\\/]+readme-read-events\.json|readme-read-events\.json)\b/i;
// -[ce]\b ir \/c\b: be \b "-ErrorAction" ar "/custom" klaidingai mačintų -E / /c prefiksą.
const inlineExecutorRegex =
  /\b(?:node|python3?|py|perl|ruby|pwsh|powershell|cmd|bash|sh)\b\s+(?:-enc(?:odedcommand)?\b|-[ce]\b|\/c\b)/i;

const allowedGeneratedHookRuntimeCommands = [
  /\bnpm\s+run\s+build\b/i,
  /\bnpm\s+run\s+typecheck\b/i,
  /\btsc\b.*(?:-p|--project)\s+tsconfig\.json\b/i,
];

const allowedCommandSegments = [
  /^(?:rg|grep|findstr)\b/i,
  /^git\s+(?:status|diff|show|log|rev-parse|branch|ls-files|grep|describe|blame|shortlog)\b/i,
  // git remote tik read formomis (remote add/set-url keičia konfigūraciją).
  /^git\s+remote(?:\s+(?:-v|show\b.*))?$/i,
  // gh read-only subkomandos: PR/issue/run/release peržiūra ir sąrašai. gh api neleidžiamas (gali mutuoti).
  /^gh\s+(?:pr|issue|run|release|repo)\s+(?:view|list|status|checks|diff)\b/i,
  /^gh\s+auth\s+status\b/i,
  // Untrack-only: --cached niekada neliečia worktree failų, tik git indeksą.
  /^git\s+rm\b(?=.*\s--cached\b)/i,
  // Operatorinis git kanalas (etalono task 0000-2, HUMAN-REVIEW-APPROVED 2026-08-14). TIK trys formos:
  //   1) `git -C <.claude/worktrees/...> add <takai>` — kelio prefiksas fiksuotas regex'u,
  //      takai negali prasidėti brūkšniu (jokių flag'ų, jokio --force);
  //   2) `git -C <tas pats prefiksas> commit -m "<žinutė>"` — žinutė tik dvigubose kabutėse,
  //      be papildomų flag'ų (jokio --amend/--no-verify);
  //   3) `git merge worktree-operator<vardas>` arba `git merge ag/worker/<uuid>/<task>/a<n>`
  //      (neprivalomas -m "<žinutė>") — TIK šie du šakų vardų šablonai, jokių kitų merge formų.
  // Segmentų skaidymas (`;`, `&&`, `|`) vyksta PRIEŠ šiuos šablonus, tad injekcija per
  // kabliataškį tampa atskiru, nebe-allowlist'intu segmentu. push/reset/rebase/force čia
  // NEatsiranda — kiti draudimai nekeičiami.
  // `(?!\S*\.\.)` abiejose vietose: nei -C kelias, nei add takai negali nešti `..` traversal'o.
  /^git\s+-C\s+(?!\S*\.\.)"?(?:\.[\\/])?\.claude[\\/]worktrees[\\/][\w.+-]+(?:[\\/][\w.+-]+)*"?\s+add(?:\s+(?!-)(?!\S*\.\.)[\w.:*"'+\\/-]+)+$/i,
  /^git\s+-C\s+(?!\S*\.\.)"?(?:\.[\\/])?\.claude[\\/]worktrees[\\/][\w.+-]+(?:[\\/][\w.+-]+)*"?\s+commit\s+-m\s+"[^"]*"$/i,
  /^git\s+merge\s+(?:worktree-operator[\w.+-]+|ag\/worker\/[0-9a-f][0-9a-f-]{7,}\/[\w.-]+\/a\d+)(?:\s+-m\s+"[^"]*")?$/i,
  // DB priežiūros skriptai: db-check read-only, db-migrate idempotentiškas ir transakcinis.
  // db-reset/db-seed SĄMONINGAI neleidžiami (destructive/seed — tik žmogus).
  /^node\s+tools[\\/]scripts[\\/]db-(?:check|migrate)\.js$/i,
  // Standartinis orkestratoriaus paleidimo entrypoint (be papildomų argumentų).
  // loop-guard yra read-only pre-loop pasiruošimo patikra (nieko nejudina).
  // `(?:pnpm\s+)?` — npm-package režime target projektas neturi pnpm ag script'o,
  // komanda kviečiama tiesiogiai; leidžiamos TOS PAČIOS subkomandos, saugumo profilis nesikeičia.
  /^(?:pnpm\s+)?ag\s+(?:loop|loop-guard|run-claude-loop|status)$/i,
  // Requeue saugus: tik perkelia task'ą human-review → queue ir išvalo ledger įrašą.
  /^(?:pnpm\s+)?ag\s+requeue\s+[\w.-]+\.md$/i,
  // task-move leidžiamas tik viena kryptimi: human-review → done (patikrintiems taskams).
  /^(?:pnpm\s+)?ag\s+task-move\s+AG[\\/]tasks[\\/]human-review[\\/][\w.-]+\.md\s+AG[\\/]tasks[\\/]done$/i,
  // Ledger sinchronizacija saugi: bucket'ų failai yra tiesos šaltinis, komanda be argumentų.
  /^(?:pnpm\s+)?ag\s+task-ledger-sync$/i,
  // Read-only patikros komandos, kurių reikalauja optimizavimo bangos užduočių ## Patikra.
  // Nė viena nekeičia task queue lifecycle (nejudina AG/tasks/* ir neliečia ledger įrašų);
  // jos arba tik skaito, arba rašo determinuotą ataskaitą.
  //
  // Argumentai apriboti fiksuotais bereikšmiais flag'ais. Reikšmę imantys
  // optimization-benchmark flag'ai (--config, --usage-log, --events-log,
  // --baseline-report, --out) SĄMONINGAI neleidžiami: --out yra laisvo kelio rašymo
  // primityvas, apeinantis write-policy (jis saugo tik Write/Edit tool'ą, ne subprocesą),
  // o --config leistų pakišti nefrozintą benchmark konfigą.
  /^(?:pnpm\s+)?ag\s+optimization-benchmark(?:\s+--(?:json|baseline|compare-baseline|print-hash))*$/i,
  /^(?:pnpm\s+)?ag\s+code-index\s+(?:build|check|architecture-check)$/i,
  /^(?:pnpm\s+)?ag\s+release-check$/i,
  /^(?:pnpm\s+)?ag\s+final-audit(?:\s+--json)?$/i,
  // build su sufiksu (build:ui, build:all) — tas pats saugumo profilis kaip test:*:
  // README dokumentuoja build:ui/build:all kaip pilnos sekos dalį.
  /^npm\s+(?:test|run\s+(?:build(?::[\w-]+)?|typecheck|lint|test(?::[\w-]+)?|test:architecture|check|format:check))\b/i,
  /^pnpm\s+(?:test|run\s+(?:build(?::[\w-]+)?|typecheck|lint|test(?::[\w-]+)?|test:architecture|check|format:check))\b/i,
  // Quality gates naudoja repo-scoped pnpm --dir formą; leidžiami tik santykiniai keliai
  // ir tik patikros/build script'ai, be "--" argumentų perdavimo.
  /^pnpm\s+--dir\s+(?![A-Za-z]:)(?![\\/])(?!\.\.(?:[\\/]|$))(?!.*[\\/]\.\.(?:[\\/]|$))[\w.\\/-]+\s+(?:build(?::[\w-]+)?|typecheck|lint|test(?::[\w-]+)?|test:architecture|check|format:check)$/i,
  // pnpm leidžia script'us kviesti be "run" — agentų doc (pvz. audit-director) naudoja šią formą.
  /^pnpm\s+(?:typecheck|lint|test:architecture|check|format:check)\b/i,
  /^node\s+--test(?!.*--(?:require|loader|import|env-file|experimental-loader)\b)/i,
  /^tsc\b.*(?:--noEmit|-p\b|--project\b|-b\b)/i,
  // PowerShell Get-* verb pagal konvenciją yra read-only; Select/Sort/Format/Out-String — pipeline formatavimas.
  /^Get-[A-Za-z][\w-]*\b/i,
  /^Select-String\b/i,
  /^(?:Select-Object|Sort-Object|Format-Table|Format-List|Format-Wide|Out-String)\b/i,
  /^Test-Path\b/i,
  /^Measure-Object\b/i,
  /^where(?:\.exe)?\b/i,
  /^dir\b/i,
  /^ls\b/i,
  // Unix read-only pagalbininkai pipeline'uose (Git Bash aplinkoje).
  /^(?:head|tail|wc|cat|sort|uniq|cut|nl|tr|column)\b/i,
];

export type BashCommandPolicy = {
  blockedPattern?: string;
  sensitive: boolean;
};

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

// Skaido komandą į segmentus per &&, ||, |, ; ir naujas eilutes, bet NE kabučių viduje —
// kitaip 'FAIL|failed' šablonas Select-String argumente taptų atskiru "failed" segmentu.
function commandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    // Backslash escapes the next character everywhere except inside single quotes (where bash
    // treats it literally). Consuming the escaped char keeps `\"` from being read as a quote
    // toggle — otherwise a `\"` would open a phantom string that swallows a following
    // `; rm -rf /` into one allowlisted segment, letting the hidden command run past every guard.
    if (ch === "\\" && quote !== "'") {
      current += ch;
      if (i + 1 < command.length) {
        current += command[i + 1];
        i++;
      }
      continue;
    }

    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    // Both `&&` and a lone `&` end a segment: in POSIX shells a single `&` backgrounds the
    // preceding command and starts a new one, so treating it as an ordinary character let
    // `ls & rm -rf ...` pass as one allowlisted segment. The one `&` that is NOT a separator
    // is the descriptor-merge form (`2>&1`, `>&2`), where it directly follows `>`; that stays
    // part of the current segment and is judged by the redirect rules in isAllowedSegment.
    if (ch === "&" && current.trimEnd().endsWith(">")) {
      current += ch;
      continue;
    }

    if (ch === "&") {
      segments.push(current);
      current = "";
      if (command[i + 1] === "&") i++;
      continue;
    }

    if (ch === "|") {
      segments.push(current);
      current = "";
      if (command[i + 1] === "|") i++;
      continue;
    }

    if (ch === ";" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }

    if (ch === "\r") continue;

    current += ch;
  }

  segments.push(current);
  return segments.map((segment) => normalizeCommand(segment)).filter(Boolean);
}

// Substitucija, backtick ar redirection leidžia per allowlisted komandą paleisti/rašyti bet ką.
const shellEscapePattern = /\$\(|\$\{|`|[<>]/;

// Stderr nukreipimai į stdout/null failų nerašo — saugu pašalinti prieš escape patikrą;
// visi kiti < > redirect'ai (pvz. "> out.txt") lieka blokuojami per shellEscapePattern.
const safeStderrRedirectPattern = /\s2>(?:&1|\$null|\/dev\/null)(?=\s|$)/gi;

function commandHead(segment: string): string {
  return segment.match(/^[^\s]+/)?.[0] ?? segment;
}

function isAllowedSegment(segment: string, ctx: CheckCommandContext): boolean {
  const sanitized = normalizeCommand(segment.replace(safeStderrRedirectPattern, " "));
  if (shellEscapePattern.test(sanitized)) return false;

  // Block npm/pnpm commands that pass arbitrary arguments to scripts via --
  if (/^(?:npm|pnpm)\b.*\s--\s/.test(sanitized)) return false;

  // Block ripgrep preprocessor execution: --pre runs an arbitrary command per file
  if (/^(?:rg|grep|findstr)\b/i.test(sanitized) && /\s--pre(?:-glob)?\b/i.test(sanitized)) return false;

  // Block git grep pager execution: --open-files-in-pager / -O run an arbitrary command
  // (--open matches unique-prefix abbreviations; -O may be bundled with other short flags)
  if (/^git\s+grep\b/i.test(sanitized) && /\s(?:--open\S*|-[^-\s]*O\S*)/.test(sanitized)) return false;

  if (allowedCommandSegments.some((pattern) => pattern.test(sanitized))) return true;

  // Config-driven allow path: the target project's declared checks and active-stack templates
  // (pytest, go test, ...) run here. Its own destructive guard keeps the denylist priority.
  return isAllowedCheckSegment(sanitized, ctx);
}

// N4: kai dist pasenęs, CLI praleidžia TIK šias komandas — kitaip rebuild
// būtų užrakintas paties freshness guard'o ir Bash tool liktų deadlock'e.
const distRebuildCommands = [
  /^npm (?:run build|run typecheck|test)(?: --prefix (?:"[^"]+"|\S+))?$/i,
  /^(?:npx )?tsc (?:-p|--project) \S*tsconfig(?:\.[\w-]+)?\.json(?: --noEmit)?$/i,
];

export function isDistRebuildCommand(command: string): boolean {
  if (shellEscapePattern.test(command)) return false;
  if (/&&|\|\||[;|]|\r?\n/.test(command)) return false;
  const normalized = normalizeCommand(command);
  return distRebuildCommands.some((pattern) => pattern.test(normalized));
}

export function evaluateBashCommandPolicy(
  command: string,
  ctx: CheckCommandContext = EMPTY_CHECK_COMMAND_CONTEXT,
): BashCommandPolicy {
  const normalized = normalizeCommand(command);
  const generatedHookRuntimeMatch = normalized.match(generatedHookRuntimeRegex);
  const protectedOrchestratorStateMatch = normalized.match(protectedOrchestratorStateRegex);
  const readmeGuardEvidenceMatch = normalized.match(readmeGuardEvidenceRegex);
  const inlineExecutorMatch = normalized.match(inlineExecutorRegex);
  const allowedGeneratedHookRuntimeCommand = allowedGeneratedHookRuntimeCommands.some((pattern) =>
    pattern.test(normalized),
  );

  if (readmeGuardEvidenceMatch) {
    return { blockedPattern: readmeGuardEvidenceMatch[0], sensitive: sensitiveRegex.test(normalized) };
  }

  if (protectedOrchestratorStateMatch) {
    return { blockedPattern: protectedOrchestratorStateMatch[0], sensitive: sensitiveRegex.test(normalized) };
  }

  if (generatedHookRuntimeMatch && !allowedGeneratedHookRuntimeCommand) {
    return { blockedPattern: generatedHookRuntimeMatch[0], sensitive: sensitiveRegex.test(normalized) };
  }

  if (inlineExecutorMatch) {
    return { blockedPattern: inlineExecutorMatch[0], sensitive: sensitiveRegex.test(normalized) };
  }

  // Segmentuojama neapdorota komanda, kad naujos eilutės būtų atskiri segmentai, o ne sulieti į vieną.
  for (const segment of commandSegments(command)) {
    if (!isAllowedSegment(segment, ctx)) {
      return { blockedPattern: `not-allowlisted:${commandHead(segment)}`, sensitive: sensitiveRegex.test(normalized) };
    }
  }

  return { sensitive: sensitiveRegex.test(normalized) };
}
