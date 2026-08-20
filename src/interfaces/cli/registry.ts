// VIEŠAS CLI kontraktas (etalonai: core/cli.ts CliCommand forma 1:1 + orchestrator/runtime/
// command-registry.ts registro idėja). Kiekviena `verqestra <komanda>` deklaruojama registre;
// handler'ius su realiais portais suriša TIK composition (VQ-504) — interfaces sluoksnis
// infrastructure neimportuoja. Komandos pridedamos/pervadinamos tik su migracijos ar alias
// sprendimu.
//
// E5 skirtumas nuo etalono: handler'iai GRĄŽINA exit kodą (0 sėkmė, 2 usage, ...) vietoj
// tiesioginio process.exitCode mutavimo — cli.ts (VQ-504) jį priskiria vienoje vietoje, o
// CLI matomas elgesys (spausdintos eilutės + galutinis exit kodas) lieka 1:1 su etalonu.

export type CliCommand = {
  name: string;
  usage?: string;
  description: string;
  run: (args: string[]) => Promise<number> | number;
};

/** CLI išvesties kanalai. Handler'iai spausdina TIK per šį portą — testai perima eilutes. */
export type CliIo = {
  out(line: string): void;
  error(line: string): void;
};

export const consoleCliIo: CliIo = {
  out(line: string): void {
    console.log(line);
  },
  error(line: string): void {
    console.error(line);
  },
};

/** Komanda pagal tikslų vardą arba `undefined` — kvietėjas sprendžia, kaip raportuoti. */
export function findCliCommand(commands: readonly CliCommand[], name: string): CliCommand | undefined {
  return commands.find((command) => command.name === name);
}

/** Vienos komandos help eilutė: `name usage — description` (usage praleidžiamas, jei nėra). */
export function renderCliCommandLine(command: CliCommand): string {
  const usage = command.usage ? ` ${command.usage}` : "";
  return `${command.name}${usage} — ${command.description}`;
}

/** Pilnas komandų sąrašas help išvesčiai — registro deklaravimo tvarka, be rūšiavimo. */
export function renderCliCommandList(commands: readonly CliCommand[]): string[] {
  return commands.map((command) => renderCliCommandLine(command));
}

/**
 * Registro invariantas kompozicijai ir testams: vardai unikalūs ir netušti. Grąžina
 * pažeidimų sąrašą (tuščias = registras validus) — kvietėjas sprendžia, mesti ar raportuoti.
 */
export function validateCliRegistry(commands: readonly CliCommand[]): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    if (!command.name.trim()) violations.push("command with empty name");
    if (seen.has(command.name)) violations.push(`duplicate command name: ${command.name}`);
    seen.add(command.name);
  }
  return violations;
}
