import type { ParsedCommand } from "./types.js";

const REPO_SLUG_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Matches owner/repo or owner/repo@branch at the start of a string */
const LEADING_REPO_REGEX = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:@([A-Za-z0-9._/-]+))?\s+/;

function stripMentionPrefix(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

/**
 * Extract repo + optional base branch + task from a "target | task" or "target task" string.
 * Supports both `owner/repo[@branch] | task` and `owner/repo[@branch] task` formats.
 */
function parseRepoAndTask(remainder: string): ParsedCommand {
  // Try pipe separator first (explicit format)
  const separatorIndex = remainder.indexOf("|");
  if (separatorIndex !== -1) {
    const target = remainder.slice(0, separatorIndex).trim();
    const task = remainder.slice(separatorIndex + 1).trim();

    if (!task) {
      return { type: "invalid", reason: "Task is required after |" };
    }

    return parseRepoTarget(target, task);
  }

  // Try natural format: owner/repo[@branch] followed by task text
  const match = remainder.match(LEADING_REPO_REGEX);
  if (match?.[1]) {
    const repoPart = match[1];
    const baseBranch = match[2]?.trim() || undefined;
    const task = remainder.slice(match[0].length).trim();

    if (!task) {
      return { type: "invalid", reason: "Task is required after the repo slug." };
    }

    if (!REPO_SLUG_REGEX.test(repoPart)) {
      return { type: "invalid", reason: "Repo must be in owner/repo format." };
    }

    return {
      type: "run",
      payload: { repoSlug: repoPart, task, baseBranch }
    };
  }

  return {
    type: "invalid",
    reason: "Could not parse repo and task. Example: `owner/repo Fix the bug` or `run owner/repo | Fix the bug`"
  };
}

function parseRepoTarget(target: string, task: string): ParsedCommand {
  const [repoPart, baseBranchPart] = target.split("@");
  if (!repoPart) {
    return {
      type: "invalid",
      reason: "Repo is required. Example: run hubstaff/hubstaff-server | Fix failing spec"
    };
  }

  if (!REPO_SLUG_REGEX.test(repoPart)) {
    return { type: "invalid", reason: "Repo must be in owner/repo format." };
  }

  return {
    type: "run",
    payload: {
      repoSlug: repoPart,
      task,
      baseBranch: baseBranchPart?.trim() || undefined
    }
  };
}

export function parseCommand(text: string): ParsedCommand {
  const normalized = stripMentionPrefix(text);
  if (!normalized || normalized.toLowerCase() === "help") {
    return { type: "help" };
  }

  if (normalized.toLowerCase() === "status") {
    return { type: "status" };
  }

  if (normalized.toLowerCase().startsWith("status ")) {
    const runId = normalized.slice("status ".length).trim();
    return { type: "status", runId: runId || undefined };
  }

  if (normalized.toLowerCase() === "tail") {
    return { type: "tail" };
  }

  if (normalized.toLowerCase().startsWith("tail ")) {
    const runId = normalized.slice("tail ".length).trim();
    return { type: "tail", runId: runId || undefined };
  }

  // Explicit "run" prefix
  if (normalized.toLowerCase().startsWith("run ")) {
    const remainder = normalized.slice("run ".length).trim();
    return parseRepoAndTask(remainder);
  }

  // Natural format: owner/repo[@branch] task (no "run" prefix needed)
  const repoMatch = normalized.match(LEADING_REPO_REGEX);
  if (repoMatch?.[1]) {
    return parseRepoAndTask(normalized);
  }

  return {
    type: "invalid",
    reason:
      "Unknown command. Use `help`, `status [run-id]`, `tail [run-id]`, or `owner/repo <task>`"
  };
}
