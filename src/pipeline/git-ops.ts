import { runShell, runShellCapture, shellEscape } from "./shell.js";

export interface CommitResult {
  commitSha: string;
  changedFiles: string[];
}

/**
 * Stage all changes, commit, capture SHA + changed files, optionally push.
 *
 * Shared by commit, fix_ci, and fix_browser nodes.
 * Caller is responsible for checking whether changes exist before calling.
 */
export async function commitCaptureAndPush(
  repoDir: string,
  commitMsg: string,
  logFile: string,
  pushBranch?: string
): Promise<CommitResult> {
  await runShell("git add -A", { cwd: repoDir, logFile });
  await runShell(`git commit -m ${shellEscape(commitMsg)}`, { cwd: repoDir, logFile });

  const shaResult = await runShellCapture("git rev-parse HEAD", { cwd: repoDir, logFile });
  const commitSha = shaResult.stdout.trim().split("\n").pop()?.trim() ?? "";

  if (pushBranch) {
    await runShell(`git push origin ${shellEscape(pushBranch)}`, { cwd: repoDir, logFile });
  }

  const filesResult = await runShellCapture("git show --name-only --pretty='' HEAD", { cwd: repoDir, logFile });
  const changedFiles = filesResult.stdout
    .split("\n")
    .map(f => f.trim())
    .filter(f => f.length > 0 && !f.startsWith("---"));

  return { commitSha, changedFiles };
}
