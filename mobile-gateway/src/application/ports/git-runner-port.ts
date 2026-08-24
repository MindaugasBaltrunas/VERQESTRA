export type GitRunResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;

export interface GitRunnerPort {
  run(cwd: string, args: readonly string[]): Promise<GitRunResult>;
}
