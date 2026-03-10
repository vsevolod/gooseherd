import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";
import { logInfo, logWarn } from "../logger.js";
import type { ContainerManager } from "./container-manager.js";

export interface SandboxImageConfig {
  image?: string;
  dockerfile?: string;
  dockerfileInline?: string;
}

export interface ResolvedImage {
  image: string;
  builtLocally: boolean;
  source: "repo_config" | "global_config" | "default";
}

/**
 * Read .gooseherd.yml from cloned repo, resolve sandbox image.
 * Priority: dockerfile > dockerfile_inline > image > defaultImage
 */
export async function resolveRepoSandboxImage(
  repoDir: string,
  defaultImage: string,
  containerManager?: ContainerManager
): Promise<ResolvedImage> {
  // 1. Try reading .gooseherd.yml from the repo root
  const configPath = path.join(repoDir, ".gooseherd.yml");
  let sandboxConfig: SandboxImageConfig | undefined;

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && parsed.sandbox) {
      const sb = parsed.sandbox as Record<string, unknown>;
      sandboxConfig = {
        image: typeof sb.image === "string" ? sb.image : undefined,
        dockerfile: typeof sb.dockerfile === "string" ? sb.dockerfile : undefined,
        dockerfileInline: typeof sb.dockerfile_inline === "string" ? sb.dockerfile_inline : undefined,
      };
    }
  } catch {
    // No .gooseherd.yml or invalid — fall back to defaults
  }

  if (!sandboxConfig) {
    logInfo("sandbox-image: no .gooseherd.yml sandbox config, using default", { defaultImage });
    return { image: defaultImage, builtLocally: false, source: "default" };
  }

  // Priority: dockerfile > dockerfile_inline > image
  if (sandboxConfig.dockerfile) {
    const dockerfilePath = path.resolve(repoDir, sandboxConfig.dockerfile);
    return buildFromDockerfile(dockerfilePath, containerManager);
  }

  if (sandboxConfig.dockerfileInline) {
    return buildFromInlineDockerfile(sandboxConfig.dockerfileInline, repoDir, containerManager);
  }

  if (sandboxConfig.image) {
    logInfo("sandbox-image: using repo-configured image", { image: sandboxConfig.image });
    return { image: sandboxConfig.image, builtLocally: false, source: "repo_config" };
  }

  logInfo("sandbox-image: empty sandbox config, using default", { defaultImage });
  return { image: defaultImage, builtLocally: false, source: "default" };
}

async function buildFromDockerfile(
  dockerfilePath: string,
  containerManager?: ContainerManager
): Promise<ResolvedImage> {
  let content: string;
  try {
    content = await readFile(dockerfilePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    logWarn("sandbox-image: Dockerfile not found, falling back to default", { path: dockerfilePath, error: msg });
    return { image: "gooseherd/sandbox:default", builtLocally: false, source: "default" };
  }

  return buildImageFromContent(content, path.dirname(dockerfilePath), dockerfilePath, containerManager);
}

async function buildFromInlineDockerfile(
  content: string,
  contextDir: string,
  containerManager?: ContainerManager
): Promise<ResolvedImage> {
  const { writeFile: writeFileAsync, mkdir } = await import("node:fs/promises");
  const tmpDir = path.join(contextDir, ".gooseherd-build");
  await mkdir(tmpDir, { recursive: true });
  const tmpDockerfile = path.join(tmpDir, "Dockerfile");
  await writeFileAsync(tmpDockerfile, content, "utf8");

  return buildImageFromContent(content, contextDir, tmpDockerfile, containerManager);
}

async function buildImageFromContent(
  content: string,
  contextDir: string,
  dockerfilePath: string,
  containerManager?: ContainerManager
): Promise<ResolvedImage> {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  const imageTag = `gooseherd/sandbox:custom-${hash}`;

  // Check if image already exists (cache hit)
  if (containerManager) {
    const exists = await containerManager.imageExists(imageTag);
    if (exists) {
      logInfo("sandbox-image: cache hit, reusing built image", { imageTag });
      return { image: imageTag, builtLocally: false, source: "repo_config" };
    }
  }

  // Build the image
  logInfo("sandbox-image: building custom image", { imageTag, dockerfile: dockerfilePath });

  if (!containerManager) {
    logWarn("sandbox-image: no container manager, cannot build custom image — using default");
    return { image: "gooseherd/sandbox:default", builtLocally: false, source: "default" };
  }

  await buildImage(contextDir, dockerfilePath, imageTag);
  logInfo("sandbox-image: build complete", { imageTag });
  return { image: imageTag, builtLocally: true, source: "repo_config" };
}

async function buildImage(
  contextDir: string,
  dockerfilePath: string,
  imageTag: string
): Promise<void> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  // Build using docker CLI (simpler than dockerode build API for file context)
  const relDockerfile = path.relative(contextDir, dockerfilePath);
  const cmd = `docker build -t ${imageTag} -f ${relDockerfile} ${contextDir}`;

  try {
    const { stderr } = await execAsync(cmd, { timeout: 300_000 }); // 5 min timeout
    if (stderr) {
      logInfo("sandbox-image: build stderr", { stderr: stderr.slice(0, 500) });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    throw new Error(`Failed to build sandbox image: ${msg}`);
  }
}
