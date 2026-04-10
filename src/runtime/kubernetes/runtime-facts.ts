import { defaultJobName } from "./job-spec.js";
import { KubernetesResourceClient, type V1Job, type V1Pod } from "./resource-client.js";
import type { TerminalFact } from "../terminal-fact.js";

type RuntimeFactsResourceClient = Pick<KubernetesResourceClient, "readJob" | "listPodsForJob">;

export async function readKubernetesTerminalFact(
  resourceClient: RuntimeFactsResourceClient,
  jobName: string,
  namespace: string,
): Promise<TerminalFact> {
  const job = await resourceClient.readJob(jobName, namespace);
  if (!job) {
    return "missing";
  }

  const conditions = Array.isArray(job.status?.conditions)
    ? job.status.conditions as Array<{ type?: string; status?: string }>
    : [];
  if (conditions.some((condition) => condition.type === "Complete" && condition.status === "True")) {
    return "succeeded";
  }
  if (conditions.some((condition) => condition.type === "Failed" && condition.status === "True")) {
    return "failed";
  }

  const pods = await resourceClient.listPodsForJob(jobName, namespace);
  const pod = pods[0];
  const phase = pod?.status?.phase;
  if (phase === "Succeeded") {
    return "succeeded";
  }
  if (phase === "Failed") {
    return "failed";
  }

  const waitingReason = pod?.status?.containerStatuses?.[0]?.state?.waiting?.reason;
  if (waitingReason === "ImagePullBackOff" || waitingReason === "ErrImagePull") {
    return "failed";
  }

  return "running";
}

interface KubernetesRuntimeFactsReaderDeps {
  namespace: string;
  resourceClient?: RuntimeFactsResourceClient;
}

export class KubernetesRuntimeFactsReader {
  private resourceClientInstance: RuntimeFactsResourceClient | undefined;

  constructor(private readonly deps: KubernetesRuntimeFactsReaderDeps) {
    this.resourceClientInstance = deps.resourceClient;
  }

  private get resourceClient(): RuntimeFactsResourceClient {
    this.resourceClientInstance ??= KubernetesResourceClient.fromDefaultConfig();
    return this.resourceClientInstance;
  }

  async getTerminalFact(runId: string): Promise<TerminalFact> {
    return readKubernetesTerminalFact(this.resourceClient, defaultJobName(runId), this.deps.namespace);
  }
}

export type { RuntimeFactsResourceClient, V1Job, V1Pod };
