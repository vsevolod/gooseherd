import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionResult, RunRecord } from "../types.js";
import type { RunExecutionBackend, RunExecutionContext } from "./backend.js";
import type { ControlPlaneStore } from "./control-plane-store.js";
import type { RunnerArtifactStore } from "./control-plane-router.js";
import type { RunCompletionRecord } from "./control-plane-types.js";
import type { RunStore } from "../store.js";
import {
  buildRunJobSpec,
  buildRunTokenSecretManifest,
  defaultSmokeJobName,
  defaultSmokeSecretName,
} from "./kubernetes/job-spec.js";
import { KubernetesResourceClient } from "./kubernetes/resource-client.js";

type TerminalFact = "succeeded" | "failed" | "missing" | "running";

interface KubernetesExecutionBackendDeps {
  controlPlaneStore: Pick<ControlPlaneStore, "createRunEnvelope" | "issueRunToken" | "getLatestCompletion">;
  artifactStore: Pick<RunnerArtifactStore, "allocateTargets">;
  runStore: Pick<RunStore, "getRun">;
  workRoot: string;
  runnerImage: string;
  internalBaseUrl: string;
  namespace?: string;
  resourceClient?: Pick<KubernetesResourceClient, "applySecret" | "applyJob" | "readJob" | "listPodsForJob" | "readJobLogs" | "deleteJob" | "deletePodsForJob" | "deleteSecret">;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
}

function toYamlValue(value: string): string {
  return JSON.stringify(value);
}

function renderManifestYaml(
  secret: ReturnType<typeof buildRunTokenSecretManifest>,
  job: ReturnType<typeof buildRunJobSpec>,
): string {
  return [
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    `  name: ${secret.metadata.name}`,
    `  namespace: ${secret.metadata.namespace}`,
    "  labels:",
    `    app.kubernetes.io/name: ${secret.metadata.labels["app.kubernetes.io/name"]}`,
    `    gooseherd.run/id: ${secret.metadata.labels["gooseherd.run/id"]}`,
    "type: Opaque",
    "stringData:",
    `  RUN_TOKEN: ${toYamlValue(secret.stringData.RUN_TOKEN)}`,
    "---",
    "apiVersion: batch/v1",
    "kind: Job",
    "metadata:",
    `  name: ${job.metadata.name}`,
    `  namespace: ${job.metadata.namespace}`,
    "  labels:",
    `    app.kubernetes.io/name: ${job.metadata.labels["app.kubernetes.io/name"]}`,
    `    gooseherd.run/id: ${job.metadata.labels["gooseherd.run/id"]}`,
    "spec:",
    `  backoffLimit: ${job.spec.backoffLimit}`,
    `  ttlSecondsAfterFinished: ${job.spec.ttlSecondsAfterFinished}`,
    "  template:",
    "    metadata:",
    "      labels:",
    `        app.kubernetes.io/name: ${job.spec.template.metadata.labels["app.kubernetes.io/name"]}`,
    `        gooseherd.run/id: ${job.spec.template.metadata.labels["gooseherd.run/id"]}`,
    "    spec:",
    `      restartPolicy: ${job.spec.template.spec.restartPolicy}`,
    "      volumes:",
    "        - name: work",
    "          emptyDir: {}",
    "      containers:",
    "        - name: runner",
    `          image: ${job.spec.template.spec.containers[0]!.image}`,
    `          imagePullPolicy: ${job.spec.template.spec.containers[0]!.imagePullPolicy}`,
    "          volumeMounts:",
    "            - name: work",
    "              mountPath: /work",
    "          env:",
    ...job.spec.template.spec.containers[0]!.env.map((entry) => {
      if ("value" in entry) {
        return [
          `            - name: ${entry.name}`,
          `              value: ${toYamlValue(entry.value)}`,
        ].join("\n");
      }
      return [
        `            - name: ${entry.name}`,
        "              valueFrom:",
        "                secretKeyRef:",
        `                  name: ${entry.valueFrom.secretKeyRef.name}`,
        `                  key: ${entry.valueFrom.secretKeyRef.key}`,
      ].join("\n");
    }),
    "",
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export class KubernetesExecutionBackend implements RunExecutionBackend<"kubernetes"> {
  readonly runtime = "kubernetes" as const;
  private readonly namespace: string;
  private readonly pollIntervalMs: number;
  private readonly waitTimeoutMs: number;
  private readonly resourceClient: Pick<KubernetesResourceClient, "applySecret" | "applyJob" | "readJob" | "listPodsForJob" | "readJobLogs" | "deleteJob" | "deletePodsForJob" | "deleteSecret">;

  constructor(private readonly deps: KubernetesExecutionBackendDeps) {
    this.namespace = deps.namespace ?? "default";
    this.pollIntervalMs = Math.max(250, deps.pollIntervalMs ?? 2_000);
    this.waitTimeoutMs = Math.max(5_000, deps.waitTimeoutMs ?? 10 * 60 * 1_000);
    this.resourceClient = deps.resourceClient ?? KubernetesResourceClient.fromDefaultConfig();
  }

  async execute(run: RunRecord & { runtime: "kubernetes" }, ctx: RunExecutionContext): Promise<ExecutionResult> {
    await ctx.onPhase("agent");
    await ctx.onDetail?.("Launching Kubernetes job.");

    const runDir = path.resolve(this.deps.workRoot, run.id);
    await mkdir(runDir, { recursive: true });
    const manifestPath = path.join(runDir, "kubernetes-job.yaml");
    const logsPath = path.join(runDir, "run.log");

    const payload = await this.deps.runStore.getRun(run.id) ?? run;
    await this.deps.controlPlaneStore.createRunEnvelope({
      runId: run.id,
      payloadRef: `payload/${run.id}`,
      payloadJson: { run: payload },
      runtime: "kubernetes",
    });
    await this.deps.artifactStore.allocateTargets(run.id);

    const token = await this.deps.controlPlaneStore.issueRunToken(run.id);
    const secretName = defaultSmokeSecretName(run.id);
    const jobName = defaultSmokeJobName(run.id);
    const secret = buildRunTokenSecretManifest({
      runId: run.id,
      namespace: this.namespace,
      secretName,
      runToken: token.token,
    });
    const job = buildRunJobSpec({
      runId: run.id,
      namespace: this.namespace,
      image: this.deps.runnerImage,
      secretName,
      internalBaseUrl: normalizeBaseUrl(this.deps.internalBaseUrl),
      pipelineFile: ctx.pipelineFile ?? "pipelines/pipeline.yml",
      jobName,
    });
    await writeFile(manifestPath, renderManifestYaml(secret, job), "utf8");

    try {
      await this.resourceClient.applySecret(secret);
      await this.resourceClient.applyJob(job);
      const runtimeFact = await this.waitForTerminalFact(jobName, ctx.abortSignal, ctx.onDetail);
      await this.captureLogs(jobName, logsPath);
      const completion = await this.deps.controlPlaneStore.getLatestCompletion(run.id);
      return this.translateOutcome(run, completion, runtimeFact);
    } finally {
      await this.cleanup(jobName, secretName).catch(() => {});
    }
  }

  private async waitForTerminalFact(
    jobName: string,
    abortSignal?: AbortSignal,
    onDetail?: (detail: string) => Promise<void>,
  ): Promise<TerminalFact> {
    const deadline = Date.now() + this.waitTimeoutMs;

    while (Date.now() < deadline) {
      if (abortSignal?.aborted) {
        throw new Error("Run cancelled");
      }

      const fact = await this.readRuntimeFact(jobName);
      if (fact !== "running") {
        return fact;
      }

      await onDetail?.(`Waiting for Kubernetes job ${jobName} to reach terminal state.`);
      await sleep(this.pollIntervalMs);
    }

    throw new Error(`Timed out waiting for Kubernetes job ${jobName}`);
  }

  private async readRuntimeFact(jobName: string): Promise<TerminalFact> {
    const job = await this.resourceClient.readJob(jobName, this.namespace);
    if (!job) {
      return "missing";
    }

    const conditions = Array.isArray(job.status?.conditions) ? job.status.conditions as Array<{ type?: string; status?: string }> : [];
    if (conditions.some((condition) => condition.type === "Complete" && condition.status === "True")) {
      return "succeeded";
    }
    if (conditions.some((condition) => condition.type === "Failed" && condition.status === "True")) {
      return "failed";
    }

    const pods = await this.resourceClient.listPodsForJob(jobName, this.namespace);
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

  private translateOutcome(
    run: RunRecord,
    completion: RunCompletionRecord | null,
    runtimeFact: TerminalFact,
  ): ExecutionResult {
    if (completion?.payload.status === "success" && runtimeFact === "succeeded") {
      return {
        branchName: run.branchName,
        logsPath: run.logsPath ?? path.resolve(this.deps.workRoot, run.id, "run.log"),
        commitSha: completion.payload.commitSha ?? "",
        changedFiles: completion.payload.changedFiles ?? [],
        prUrl: completion.payload.prUrl,
        tokenUsage: completion.payload.tokenUsage,
        title: completion.payload.title,
      };
    }

    if (completion?.payload.status === "failed") {
      throw new Error(completion.payload.reason ?? "Kubernetes runner reported failed completion");
    }

    if (runtimeFact === "failed") {
      throw new Error("completion missing after terminal runtime state");
    }

    if (runtimeFact === "missing") {
      throw new Error("Kubernetes job disappeared before completion");
    }

    throw new Error("Kubernetes runtime did not produce a terminal success result");
  }

  private async cleanup(jobName: string, secretName: string): Promise<void> {
    await this.resourceClient.deleteJob(jobName, this.namespace);
    await this.resourceClient.deletePodsForJob(jobName, this.namespace);
    await this.resourceClient.deleteSecret(secretName, this.namespace);
  }

  private async captureLogs(jobName: string, logsPath: string): Promise<void> {
    try {
      const logs = await this.resourceClient.readJobLogs(jobName, this.namespace);
      await writeFile(logsPath, logs, "utf8");
    } catch {
      // Leave logsPath absent when the runner never reached a readable logging state.
    }
  }
}
