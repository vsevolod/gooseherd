export interface ArtifactStore {
  allocateTargets(runId: string): Promise<{
    targets: Record<string, { class: string; path: string; uploadUrl: string }>;
  }>;
}
