import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ArtifactStore } from "./artifact-store.js";
import type { ControlPlaneStore } from "./control-plane-store.js";
import { normalizeBaseUrl } from "./url.js";

export class FileArtifactStore implements ArtifactStore {
  constructor(
    private readonly workRoot: string,
    private readonly publicBaseUrl: string,
    private readonly controlPlaneStore: ControlPlaneStore,
  ) {}

  async allocateTargets(runId: string): Promise<{
    targets: Record<string, { class: string; path: string; uploadUrl: string }>;
  }> {
    const basePath = path.join(this.workRoot, runId, "artifacts");
    const artifactPath = path.join(basePath, "run.log");
    await mkdir(basePath, { recursive: true });

    await this.controlPlaneStore.upsertArtifact(runId, "run.log", "raw_run_log", {
      storage: "file",
      path: artifactPath,
    });

    return {
      targets: {
        log: {
          class: "raw_run_log",
          path: artifactPath,
          uploadUrl: `${normalizeBaseUrl(this.publicBaseUrl)}/api/runs/${encodeURIComponent(runId)}/artifacts/run.log`,
        },
      },
    };
  }
}
