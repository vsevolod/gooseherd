import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { logInfo, logWarn } from "../logger.js";

export interface SkillDefinition {
  name: string;
  description: string;
  language?: string;
  /** Shell command template — used by `run` action nodes */
  command?: string;
  /** English instruction — used by `skill` action nodes */
  instruction?: string;
  timeout_seconds?: number;
}

const skills = new Map<string, SkillDefinition>();

/**
 * Load all skill definitions from a directory of YAML files.
 * Called once at startup.
 */
export async function loadSkills(skillsDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    logWarn(`Skills directory not found: ${skillsDir} — no skills loaded`);
    return;
  }

  const ymlFiles = entries.filter(f => f.endsWith(".yml") || f.endsWith(".yaml"));

  for (const file of ymlFiles) {
    const filePath = path.join(skillsDir, file);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = parseYaml(raw) as Record<string, unknown>;

      if (!parsed || typeof parsed !== "object" || typeof parsed["name"] !== "string") {
        logWarn(`Skipping skill file ${file}: missing 'name' field`);
        continue;
      }

      const skill: SkillDefinition = {
        name: parsed["name"] as string,
        description: (parsed["description"] as string) ?? "",
        language: parsed["language"] as string | undefined,
        command: parsed["command"] as string | undefined,
        instruction: parsed["instruction"] as string | undefined,
        timeout_seconds: parsed["timeout_seconds"] as number | undefined,
      };

      skills.set(skill.name, skill);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      logWarn(`Failed to parse skill file ${file}: ${msg}`);
    }
  }

  logInfo(`Loaded ${String(skills.size)} skill(s) from ${skillsDir}`);
}

/** Look up a skill by name. Returns undefined if not found. */
export function getSkill(name: string): SkillDefinition | undefined {
  return skills.get(name);
}

/** List all loaded skills. */
export function listSkills(): SkillDefinition[] {
  return Array.from(skills.values());
}

/** Clear all loaded skills (used by tests). */
export function clearSkills(): void {
  skills.clear();
}
