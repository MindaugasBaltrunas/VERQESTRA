// Eilučių taisyklių variklis guard'ams (etalonas: AG_loop hooks/line-rule-engine.ts 1:1).
// Grynas: taisyklė mato tik failo vardą, turinį ir vieną eilutę, o rezultatas — radinių
// eilutės plius vėliava, ar bent viena taisyklė blokuoja.

export type LineRuleContext = {
  file: string;
  content: string;
  line: string;
  lineNumber: number;
};

export type LineRule = {
  matches: (context: LineRuleContext) => boolean;
  findings: (context: LineRuleContext) => string[];
  /** `true` — atitikimas blokuoja įvykį; kitaip radinys lieka įspėjimu žurnale. */
  blocks?: boolean;
};

export type LineRuleScan = {
  findings: string[];
  blocked: boolean;
};

/**
 * Pritaiko visas taisykles kiekvienai eilutei. VISOS taisyklės tikrinamos kiekvienai eilutei
 * (be `break` po pirmo atitikimo): guard'o žurnalas turi rodyti pilną radinių sąrašą, o ne
 * pirmą kliūtį — antraip ištaisius vieną pažeidimą kitas pasirodytų tik kitame rate.
 */
export function scanLineRules(file: string, content: string, rules: readonly LineRule[]): LineRuleScan {
  const findings: string[] = [];
  let blocked = false;

  content.split(/\r?\n/).forEach((line, index) => {
    const context: LineRuleContext = { file, content, line, lineNumber: index + 1 };
    for (const rule of rules) {
      if (!rule.matches(context)) continue;
      findings.push(...rule.findings(context));
      blocked ||= rule.blocks === true;
    }
  });

  return { findings, blocked };
}

export function numberedLine(context: LineRuleContext): string {
  return `${context.lineNumber}:${context.line}`;
}
