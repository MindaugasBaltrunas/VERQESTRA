// The only entrypoint (LAY-2). No business logic lives here — commands are wired
// through src/composition/* as they arrive (E5); until then the CLI answers with
// the project-wide exit conventions so the contract is pinned from the first commit:
// exit 0 = success, exit 2 = usage error (see AG_loop core/exit-codes.ts etalon).
const USAGE_ERROR_EXIT_CODE = 2;

function main(argv: readonly string[]): number {
  const command = argv[0];
  if (command === undefined || command === "--version" || command === "version") {
    process.stdout.write("verqestra 0.1.0\n");
    return 0;
  }
  process.stderr.write(`Usage: verqestra [version]\nUnknown command: ${command}\n`);
  return USAGE_ERROR_EXIT_CODE;
}

process.exitCode = main(process.argv.slice(2));
