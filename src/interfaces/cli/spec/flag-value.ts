// Bendras `--flag=value` / `--flag value` parsinimas eksporto komandoms (etalono
// flagValue 1:1 — etalone dubliuotas abiejuose export-* adapteriuose, čia vienas modulis).

export function flagValue(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim() || undefined;
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1]?.trim() || undefined : undefined;
}
