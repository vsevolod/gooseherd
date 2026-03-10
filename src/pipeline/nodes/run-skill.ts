/**
 * Run-Skill Node — looks up a named skill from the registry and
 * delegates to the `run` or `skill` node handler depending on
 * whether the skill defines a command or an instruction.
 */

import type { NodeConfig, NodeResult, NodeDeps } from "../types.js";
import type { ContextBag } from "../context-bag.js";
import { getSkill } from "../skill-registry.js";
import { appendLog } from "../shell.js";

export async function runSkillNode(
  nodeConfig: NodeConfig,
  ctx: ContextBag,
  deps: NodeDeps
): Promise<NodeResult> {
  const logFile = deps.logFile;
  const skillName = nodeConfig.config?.skill as string | undefined;

  if (!skillName || !skillName.trim()) {
    return { outcome: "failure", error: "run_skill node requires config.skill (skill name)" };
  }

  const skill = getSkill(skillName);
  if (!skill) {
    await appendLog(logFile, `[run_skill] skill '${skillName}' not found in registry\n`);
    return { outcome: "failure", error: `Skill '${skillName}' not found in registry` };
  }

  if (skill.command) {
    const syntheticConfig: NodeConfig = {
      id: nodeConfig.id,
      type: nodeConfig.type,
      action: "run",
      config: {
        command: skill.command,
        timeout_seconds: skill.timeout_seconds,
        ...nodeConfig.config,
        skill: undefined, // don't pass through
      },
    };

    const { runNode } = await import("./run.js");
    await appendLog(logFile, `[run_skill] delegating '${skillName}' → run node (command)\n`);
    return runNode(syntheticConfig, ctx, deps);
  }

  if (skill.instruction) {
    const syntheticConfig: NodeConfig = {
      id: nodeConfig.id,
      type: nodeConfig.type,
      action: "skill",
      config: {
        instruction: skill.instruction,
        mode: "agent",
        timeout_seconds: skill.timeout_seconds,
        ...nodeConfig.config,
        skill: undefined, // don't pass through
      },
    };

    const { skillNode } = await import("./skill.js");
    await appendLog(logFile, `[run_skill] delegating '${skillName}' → skill node (instruction)\n`);
    return skillNode(syntheticConfig, ctx, deps);
  }

  await appendLog(logFile, `[run_skill] skill '${skillName}' has neither command nor instruction\n`);
  return {
    outcome: "failure",
    error: `Skill '${skillName}' has neither command nor instruction defined`,
  };
}
