import path from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";
import type {
  PipelineConfig,
  NodeConfig,
  NodeHandler,
  NodeResult,
  NodeDeps,
  PipelineResult,
  PipelineStepResult,
  LoopConfig,
  NodeEvent,
  NodeEventListener
} from "./types.js";
import { EventLogger } from "./event-logger.js";
import type { ExecutionResult, RunRecord, TokenUsage } from "../types.js";
import type { AppConfig } from "../config.js";
import type { GitHubService } from "../github.js";
import type { RunLifecycleHooks } from "../hooks/run-lifecycle.js";
import { ContextBag } from "./context-bag.js";
import { evaluateExpression } from "./expression-evaluator.js";
import { loadPipeline } from "./pipeline-loader.js";
import { appendLog, runInSandboxContext } from "./shell.js";
import { logInfo, logError } from "../logger.js";
import type { ContainerManager } from "../sandbox/container-manager.js";
import type { SandboxHandle } from "../sandbox/types.js";

// Node handler imports
import { cloneNode } from "./nodes/clone.js";
import { hydrateContextNode } from "./nodes/hydrate-context.js";
import { implementNode } from "./nodes/implement.js";
import { lintFixNode } from "./nodes/lint-fix.js";
import { validateNode } from "./nodes/validate.js";
import { fixValidationNode } from "./nodes/fix-validation.js";
import { commitNode } from "./nodes/commit.js";
import { pushNode } from "./nodes/push.js";
import { createPrNode } from "./nodes/create-pr.js";
import { notifyNode } from "./nodes/notify.js";
import { planTaskNode } from "./nodes/plan-task.js";
import { localTestNode } from "./nodes/local-test.js";
import { uploadScreenshotNode } from "./nodes/upload-screenshot.js";
import { generateTitleNode } from "./nodes/generate-title.js";
import { summarizeChangesNode } from "./nodes/summarize-changes.js";

// Quality gate node imports
import { classifyTaskNode } from "./quality-gates/classify-task-node.js";
import { diffGateNode } from "./quality-gates/diff-gate-node.js";
import { forbiddenFilesNode } from "./quality-gates/forbidden-files-node.js";
import { securityScanNode } from "./quality-gates/security-scan-node.js";
import { scopeJudgeNode } from "./quality-gates/scope-judge-node.js";
import { browserVerifyNode } from "./quality-gates/browser-verify-node.js";

// Deploy + CI node imports
import { deployPreviewNode } from "./nodes/deploy-preview.js";
import { waitCiNode } from "./ci/wait-ci-node.js";
import { fixCiNode } from "./ci/fix-ci-node.js";
import { fixBrowserNode } from "./nodes/fix-browser.js";
import { decideNextStepNode } from "./nodes/decide-next-step.js";

// ── Node handler registry ──

const NODE_HANDLERS: Record<string, NodeHandler> = {
  clone: cloneNode,
  hydrate_context: hydrateContextNode,
  implement: implementNode,
  lint_fix: lintFixNode,
  validate: validateNode,
  fix_validation: fixValidationNode,
  commit: commitNode,
  push: pushNode,
  create_pr: createPrNode,
  notify: notifyNode,
  classify_task: classifyTaskNode,
  diff_gate: diffGateNode,
  forbidden_files: forbiddenFilesNode,
  security_scan: securityScanNode,
  wait_ci: waitCiNode,
  fix_ci: fixCiNode,
  fix_browser: fixBrowserNode,
  scope_judge: scopeJudgeNode,
  deploy_preview: deployPreviewNode,
  browser_verify: browserVerifyNode,
  plan_task: planTaskNode,
  local_test: localTestNode,
  upload_screenshot: uploadScreenshotNode,
  generate_title: generateTitleNode,
  summarize_changes: summarizeChangesNode,
  decide_next_step: decideNextStepNode
};

export type PipelinePhase = "cloning" | "agent" | "validating" | "pushing" | "awaiting_ci" | "ci_fixing";

/**
 * Pipeline engine: loads YAML pipeline, executes nodes in order,
 * checkpoints context between nodes, handles loop constructs.
 */
export class PipelineEngine {
  private readonly nodeEventListeners: NodeEventListener[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly githubService?: GitHubService,
    private readonly hooks?: RunLifecycleHooks,
    private readonly containerManager?: ContainerManager
  ) {}

  /** Register a listener for real-time node start/end events. */
  onNodeEvent(cb: NodeEventListener): void {
    this.nodeEventListeners.push(cb);
  }

  private fireNodeEvent(event: NodeEvent): void {
    for (const cb of this.nodeEventListeners) {
      try { cb(event); } catch { /* swallow */ }
    }
  }

  /**
   * Execute a pipeline for a run.
   * @param skipNodes — optional list of node IDs to skip entirely (from orchestrator classification)
   * @param enableNodes — optional list of node IDs to force-enable (overrides enabled: false in YAML)
   */
  async execute(
    run: RunRecord,
    onPhase: (phase: PipelinePhase) => Promise<void>,
    pipelineFile?: string,
    onDetail?: (detail: string) => Promise<void>,
    skipNodes?: string[],
    enableNodes?: string[]
  ): Promise<ExecutionResult> {
    const yamlPath = pipelineFile ?? path.resolve("pipelines/pipeline.yml");
    const pipeline = await loadPipeline(yamlPath);

    logInfo("Pipeline loaded", { name: pipeline.name, nodes: pipeline.nodes.length });

    const runDir = path.resolve(this.config.workRoot, run.id);
    const logFile = path.join(runDir, "run.log");
    const checkpointDir = path.join(runDir, "checkpoints");

    // Ensure run directory + log file exist before pipeline starts
    // (the clone node will rm + recreate, but we need the dir for pre-node logging)
    await mkdir(runDir, { recursive: true });
    await appendLog(logFile, `${this.config.appName} pipeline started for ${run.id}\n`);

    // Event logger — local to this execution to avoid race conditions
    // when RUNNER_CONCURRENCY > 1 (multiple execute() calls in parallel).
    const eventLogger = new EventLogger(runDir);

    // Initialize context bag
    const ctx = new ContextBag({
      runId: run.id,
      repoSlug: run.repoSlug,
      baseBranch: run.baseBranch,
      branchName: run.branchName,
      task: run.task,
      requestedBy: run.requestedBy
    });
    ctx.setCheckpointDir(checkpointDir);

    // Merge pipeline-level context
    if (pipeline.context) {
      for (const [key, value] of Object.entries(pipeline.context)) {
        ctx.set(key, value);
      }
    }

    const deps: NodeDeps = {
      config: this.config,
      run,
      githubService: this.githubService,
      hooks: this.hooks,
      logFile,
      workRoot: this.config.workRoot,
      onPhase: async (phase: string) => {
        await eventLogger.emit("phase_change", { phase });
        await onPhase(phase as PipelinePhase);
      },
      onDetail
    };

    // Try to resume from checkpoint
    const checkpoint = await ContextBag.resume(checkpointDir);
    let startIndex = 0;
    if (checkpoint) {
      const lastNodeIndex = pipeline.nodes.findIndex(n => n.id === checkpoint.lastCompletedNodeId);
      if (lastNodeIndex >= 0) {
        startIndex = lastNodeIndex + 1;
        // Restore context from checkpoint
        const resumedData = checkpoint.ctx.toObject();
        for (const [key, value] of Object.entries(resumedData)) {
          ctx.set(key, value);
        }
        logInfo("Resumed from checkpoint", { lastNode: checkpoint.lastCompletedNodeId, nextIndex: startIndex });
      }
    }

    // Create sandbox container if enabled
    let sandbox: SandboxHandle | undefined;
    if (this.config.sandboxEnabled && this.containerManager) {
      const sandboxEnv: Record<string, string> = {};

      // Pass through agent-relevant env vars
      for (const key of [
        "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
        "XAI_API_KEY", "GEMINI_API_KEY",
        "CEMS_API_URL", "CEMS_API_KEY",
        "OPENROUTER_PROVIDER_PREFERENCES"
      ]) {
        if (process.env[key]) {
          sandboxEnv[key] = process.env[key]!;
        }
      }

      // Pass git token for authenticated operations
      const gitToken = await this.githubService?.getToken();
      if (gitToken) {
        sandboxEnv["GIT_TOKEN"] = gitToken;
      }

      sandbox = await this.containerManager.createSandbox(
        run.id,
        {
          image: this.config.sandboxImage,
          cpus: this.config.sandboxCpus,
          memoryMb: this.config.sandboxMemoryMb,
          env: sandboxEnv,
          networkMode: "bridge"
        },
        this.config.sandboxHostWorkPath
      );

      await appendLog(logFile, `[sandbox] container created: ${sandbox.containerName}\n`);

      // Write pi-agent models.json with OpenRouter provider routing preferences
      if (this.config.openrouterProviderPreferences) {
        await this.writePiAgentModelsJson(sandbox.containerId, this.config.openrouterProviderPreferences, logFile);
      }
    }

    const skipNodeIdSet = skipNodes && skipNodes.length > 0 ? new Set(skipNodes) : undefined;
    const enableNodeIdSet = enableNodes && enableNodes.length > 0 ? new Set(enableNodes) : undefined;

    let result;
    try {
      if (sandbox) {
        // Run pipeline inside AsyncLocalStorage context so all shell calls
        // within this async tree route through the correct container.
        // Concurrent pipeline executions each get their own context.
        result = await runInSandboxContext(sandbox.containerId, run.id, () =>
          this.executePipeline(pipeline, ctx, deps, startIndex, false, eventLogger, skipNodeIdSet, enableNodeIdSet)
        );
      } else {
        result = await this.executePipeline(pipeline, ctx, deps, startIndex, false, eventLogger, skipNodeIdSet, enableNodeIdSet);
      }
    } finally {
      if (sandbox && this.containerManager) {
        await this.containerManager.destroySandbox(run.id);
        await appendLog(logFile, `[sandbox] container destroyed: ${sandbox.containerName}\n`);
      }
    }

    // Aggregate token usage from all _tokenUsage_* context bag keys
    const tokenUsage = aggregateTokenUsage(ctx);
    if (tokenUsage) {
      ctx.set("tokenUsage", tokenUsage);
    }

    // Build ExecutionResult from context bag
    const branchName = run.branchName;
    const commitSha = ctx.get<string>("commitSha") ?? "";
    const changedFiles = ctx.get<string[]>("changedFiles") ?? [];
    const prUrl = ctx.get<string>("prUrl");

    if (result.outcome === "failure") {
      const failedStep = result.steps.find(s => s.outcome === "failure");
      throw new Error(failedStep?.error ?? "Pipeline failed");
    }

    return {
      branchName,
      logsPath: logFile,
      commitSha,
      changedFiles,
      prUrl,
      tokenUsage: tokenUsage ?? undefined,
      title: ctx.get<string>("generatedTitle")
    };
  }

  private async executePipeline(
    pipeline: PipelineConfig,
    ctx: ContextBag,
    deps: NodeDeps,
    startIndex: number,
    pipelineSwitched = false,
    eventLogger?: EventLogger,
    skipNodeIds?: Set<string>,
    enableNodeIds?: Set<string>
  ): Promise<PipelineResult> {
    const steps: PipelineStepResult[] = [];
    const warnings: string[] = [];

    for (let i = startIndex; i < pipeline.nodes.length; i++) {
      const node = pipeline.nodes[i] as NodeConfig;

      // Check skipNodeIds first (explicit skip always wins)
      if (skipNodeIds?.has(node.id)) {
        steps.push({ nodeId: node.id, outcome: "skipped", durationMs: 0 });
        await eventLogger?.emit("node_end", { nodeId: node.id, outcome: "skipped", durationMs: 0 });
        await appendLog(deps.logFile, `\n[pipeline] ${node.id}: skipped (in skipNodes list)\n`);
        continue;
      }

      // Check enabled flag — enableNodes overrides enabled: false
      if (node.enabled === false && !enableNodeIds?.has(node.id)) {
        steps.push({ nodeId: node.id, outcome: "skipped", durationMs: 0 });
        await eventLogger?.emit("node_end", { nodeId: node.id, outcome: "skipped", durationMs: 0 });
        continue;
      }

      // Evaluate `if` condition
      if (node.if) {
        const configObj = this.config as unknown as Record<string, unknown>;
        const shouldRun = evaluateExpression(node.if, (varName: string) => {
          return ctx.resolve(varName, configObj);
        });
        if (!shouldRun) {
          steps.push({ nodeId: node.id, outcome: "skipped", durationMs: 0 });
          await eventLogger?.emit("node_end", { nodeId: node.id, outcome: "skipped", durationMs: 0 });
          await appendLog(deps.logFile, `\n[pipeline] ${node.id}: skipped (condition: ${node.if})\n`);
          continue;
        }
      }

      await appendLog(deps.logFile, `\n[pipeline] ${node.id}: starting\n`);
      await eventLogger?.emit("node_start", { nodeId: node.id });
      this.fireNodeEvent({ runId: deps.run.id, nodeId: node.id, action: node.action, type: "start" });
      const startTime = Date.now();

      // Execute the node
      const handler = this.getHandler(node.action);
      let result: NodeResult;

      try {
        result = await handler(node, ctx, deps);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        result = { outcome: "failure", error: message };
      }

      const durationMs = Date.now() - startTime;
      await appendLog(deps.logFile, `\n[pipeline] ${node.id}: ${result.outcome} (${String(durationMs)}ms)\n`);
      await eventLogger?.emit("node_end", {
        nodeId: node.id,
        outcome: result.outcome,
        durationMs,
        error: result.error
      });
      this.fireNodeEvent({
        runId: deps.run.id, nodeId: node.id, action: node.action,
        type: "end", outcome: result.outcome, durationMs, error: result.error
      });

      // Write outputs to context bag
      if (result.outputs) {
        ctx.mergeOutputs(result.outputs);

        // Support dynamic node skipping from decision nodes
        const dynamicSkips = result.outputs["_skipNodes"];
        if (Array.isArray(dynamicSkips)) {
          if (!skipNodeIds) {
            skipNodeIds = new Set<string>();
          }
          for (const id of dynamicSkips) {
            if (typeof id === "string") {
              skipNodeIds.add(id);
            }
          }
        }
      }

      // Handle failure with loop construct
      if (result.outcome === "failure" && node.on_failure) {
        const loopResult = await this.handleLoopFailure(
          node, result, ctx, deps, pipeline, eventLogger
        );

        if (loopResult.outcome === "success") {
          steps.push({ nodeId: node.id, outcome: "success", durationMs: Date.now() - startTime });
          await ctx.checkpoint(node.id);
          continue;
        }

        if (loopResult.outcome === "completed_with_warnings") {
          warnings.push(`${node.id}: ${loopResult.warnings.join("; ")}`);
          steps.push({ nodeId: node.id, outcome: "success", durationMs: Date.now() - startTime });
          await ctx.checkpoint(node.id);
          continue;
        }

        // Loop exhausted and no fallback
        steps.push({
          nodeId: node.id,
          outcome: "failure",
          durationMs: Date.now() - startTime,
          error: result.error ?? "Loop exhausted"
        });
        return { outcome: "failure", steps, warnings };
      }

      // Handle soft_fail
      if (result.outcome === "soft_fail") {
        if (node.on_soft_fail === "fail_run") {
          steps.push({ nodeId: node.id, outcome: "failure", durationMs, error: result.error });
          return { outcome: "failure", steps, warnings };
        }
        warnings.push(`${node.id}: ${result.error ?? "soft fail"}`);
        steps.push({ nodeId: node.id, outcome: "success", durationMs });
        await ctx.checkpoint(node.id);
        continue;
      }

      // Handle hard failure (no loop construct)
      if (result.outcome === "failure") {
        steps.push({ nodeId: node.id, outcome: "failure", durationMs, error: result.error });
        return { outcome: "failure", steps, warnings };
      }

      steps.push({ nodeId: node.id, outcome: result.outcome, durationMs });

      // Checkpoint after each successful node
      if (result.outcome === "success") {
        await ctx.checkpoint(node.id);

        // Check for per-repo pipeline override (set by clone → applyRepoConfig)
        if (!pipelineSwitched) {
          const override = ctx.get<string>("repoConfigPipeline");
          if (override) {
            const newPipeline = await this.tryLoadPipelineOverride(override, deps.logFile);
            if (newPipeline) {
              const currentIdx = newPipeline.nodes.findIndex(n => n.id === node.id);
              if (currentIdx >= 0) {
                const tailResult = await this.executePipeline(newPipeline, ctx, deps, currentIdx + 1, true, eventLogger, skipNodeIds, enableNodeIds);
                steps.push(...tailResult.steps);
                warnings.push(...tailResult.warnings);
                return { outcome: tailResult.outcome, steps, warnings };
              }
              await appendLog(deps.logFile, `[pipeline] override '${override}' does not contain node '${node.id}', ignoring\n`);
            }
          }
        }
      }
    }

    const finalOutcome = warnings.length > 0 ? "completed_with_warnings" : "success";
    return { outcome: finalOutcome, steps, warnings };
  }

  /**
   * Handle a loop-based failure recovery (validation retry, CI fix, etc.)
   */
  private async handleLoopFailure(
    failedNode: NodeConfig,
    failedResult: NodeResult,
    ctx: ContextBag,
    deps: NodeDeps,
    pipeline: PipelineConfig,
    eventLogger?: EventLogger
  ): Promise<PipelineResult> {
    const loopConfig = failedNode.on_failure as LoopConfig;
    const resolvedMaxRounds = typeof loopConfig.max_rounds === "string"
      ? Number(ctx.resolve(loopConfig.max_rounds) ?? loopConfig.max_rounds)
      : loopConfig.max_rounds;
    const maxRounds = Number.isFinite(resolvedMaxRounds) && resolvedMaxRounds > 0
      ? resolvedMaxRounds
      : 1;

    const agentHandler = this.getHandler(loopConfig.agent_node);
    const onExhausted = loopConfig.on_exhausted ?? "fail_run";
    const warnings: string[] = [];

    await appendLog(deps.logFile, `\n[pipeline] entering fix loop for ${failedNode.id} (max ${String(maxRounds)} rounds)\n`);
    await eventLogger?.emit("artifact", {
      nodeId: failedNode.id,
      artifact: `loop_start:${failedNode.id}:${loopConfig.agent_node}:${String(maxRounds)}`
    });

    // Store the last failure's raw output for the fix agent
    if (failedResult.rawOutput) {
      ctx.set("lastFailureRawOutput", failedResult.rawOutput);
    }

    let lastRawOutput = failedResult.rawOutput ?? "";

    for (let attempt = 1; attempt <= maxRounds; attempt++) {
      ctx.set("loopAttempt", attempt);

      // Run the fix agent
      await appendLog(deps.logFile, `\n[pipeline] fix loop attempt ${String(attempt)}/${String(maxRounds)}\n`);
      const fixNode: NodeConfig = {
        id: `${loopConfig.agent_node}_loop_${String(attempt)}`,
        type: "agentic",
        action: loopConfig.agent_node
      };
      const fixStart = Date.now();
      await eventLogger?.emit("node_start", { nodeId: fixNode.id });
      this.fireNodeEvent({
        runId: deps.run.id,
        nodeId: fixNode.id,
        action: fixNode.action,
        type: "start"
      });

      let fixResult: NodeResult;

      try {
        fixResult = await agentHandler(fixNode, ctx, deps);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        await appendLog(deps.logFile, `\n[pipeline] fix agent failed: ${message}\n`);
        fixResult = { outcome: "failure", error: message };
      }

      const fixDurationMs = Date.now() - fixStart;
      await eventLogger?.emit("node_end", {
        nodeId: fixNode.id,
        outcome: fixResult.outcome,
        durationMs: fixDurationMs,
        error: fixResult.error
      });
      this.fireNodeEvent({
        runId: deps.run.id,
        nodeId: fixNode.id,
        action: fixNode.action,
        type: "end",
        outcome: fixResult.outcome,
        durationMs: fixDurationMs,
        error: fixResult.error
      });

      if (fixResult.outcome !== "success") {
        await appendLog(
          deps.logFile,
          `[pipeline] fix agent outcome=${fixResult.outcome} on attempt ${String(attempt)} — skipping retry check\n`
        );
        await eventLogger?.emit("artifact", {
          nodeId: failedNode.id,
          artifact: `loop_fix_failed:${failedNode.id}:${String(attempt)}:${fixResult.outcome}`
        });
        continue;
      }
      if (fixResult.outputs) {
        ctx.mergeOutputs(fixResult.outputs);
      }

      // Run lint fix after agent fix (lint only runs after agent changes)
      // Skip for fix_ci and fix_browser which already commit+push internally
      if (loopConfig.agent_node !== "fix_ci" && loopConfig.agent_node !== "fix_browser") {
        const lintHandler = NODE_HANDLERS["lint_fix"];
        if (lintHandler && deps.config.lintFixCommand) {
          const lintNode: NodeConfig = { id: "lint_fix_post", type: "deterministic", action: "lint_fix" };
          await lintHandler(lintNode, ctx, deps);
        }
      }

      // Re-run the original node to check if fixed
      const retryHandler = this.getHandler(failedNode.action);
      let retryResult: NodeResult;
      const retryNodeId = `${failedNode.id}_retry_${String(attempt)}`;
      const retryStart = Date.now();
      await eventLogger?.emit("node_start", { nodeId: retryNodeId });
      this.fireNodeEvent({
        runId: deps.run.id,
        nodeId: retryNodeId,
        action: failedNode.action,
        type: "start"
      });
      try {
        retryResult = await retryHandler(failedNode, ctx, deps);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        retryResult = { outcome: "failure", error: message };
      }
      const retryDurationMs = Date.now() - retryStart;
      await eventLogger?.emit("node_end", {
        nodeId: retryNodeId,
        outcome: retryResult.outcome,
        durationMs: retryDurationMs,
        error: retryResult.error
      });
      this.fireNodeEvent({
        runId: deps.run.id,
        nodeId: retryNodeId,
        action: failedNode.action,
        type: "end",
        outcome: retryResult.outcome,
        durationMs: retryDurationMs,
        error: retryResult.error
      });

      if (retryResult.outcome === "success") {
        await appendLog(deps.logFile, `\n[pipeline] fix loop succeeded on attempt ${String(attempt)}\n`);
        await eventLogger?.emit("artifact", {
          nodeId: failedNode.id,
          artifact: `loop_success:${failedNode.id}:${String(attempt)}`
        });
        if (retryResult.outputs) {
          ctx.mergeOutputs(retryResult.outputs);
        }
        return { outcome: "success", steps: [], warnings };
      }

      // Merge retry outputs so next fix attempt sees updated failure context
      if (retryResult.outputs) {
        ctx.mergeOutputs(retryResult.outputs);
      }
      if (retryResult.rawOutput) {
        ctx.set("lastFailureRawOutput", retryResult.rawOutput);
        lastRawOutput = retryResult.rawOutput;
      }

      // Accumulate failure history for browser verify (and potentially other loops)
      if (failedNode.action === "browser_verify") {
        ctx.append("browserVerifyFailureHistory", {
          round: attempt,
          verdict: retryResult.outputs?.browserVerifyVerdictReason ?? retryResult.error,
          actionsPath: ctx.get("actionsPath"),
          timestamp: Date.now()
        });
      }

      await eventLogger?.emit("artifact", {
        nodeId: failedNode.id,
        artifact: `loop_retry_failed:${failedNode.id}:${String(attempt)}:${retryResult.outcome}`
      });
    }

    // Loop exhausted — include last validation output for debugging
    const lastOutputSnippet = lastRawOutput.slice(-500);
    const exhaustionError = lastOutputSnippet
      ? `Validation failed after ${String(maxRounds)} retry round(s). Last output:\n${lastOutputSnippet}`
      : `Fix loop exhausted after ${String(maxRounds)} rounds`;

    await appendLog(deps.logFile, `\n[pipeline] fix loop exhausted after ${String(maxRounds)} rounds\n`);
    await eventLogger?.emit("artifact", {
      nodeId: failedNode.id,
      artifact: `loop_exhausted:${failedNode.id}:${String(maxRounds)}`
    });

    if (onExhausted === "complete_with_warning") {
      warnings.push(`${failedNode.id} fix loop exhausted after ${String(maxRounds)} rounds — completing with warning`);
      return { outcome: "completed_with_warnings", steps: [], warnings };
    }

    return {
      outcome: "failure",
      steps: [{
        nodeId: failedNode.id,
        outcome: "failure",
        durationMs: 0,
        error: exhaustionError
      }],
      warnings
    };
  }

  private async tryLoadPipelineOverride(name: string, logFile: string): Promise<PipelineConfig | undefined> {
    // Validate: alphanumeric, hyphens, underscores only
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      await appendLog(logFile, `[pipeline] invalid override name '${name}', must be alphanumeric/hyphens/underscores\n`);
      return undefined;
    }

    const yamlPath = path.resolve("pipelines", `${name}.yml`);
    try {
      await access(yamlPath);
    } catch {
      await appendLog(logFile, `[pipeline] override pipeline not found: ${yamlPath}\n`);
      return undefined;
    }

    try {
      const pipeline = await loadPipeline(yamlPath);
      logInfo("Pipeline override loaded", { name, nodes: pipeline.nodes.length });
      await appendLog(logFile, `[pipeline] switched to override pipeline '${name}' (${String(pipeline.nodes.length)} nodes)\n`);
      return pipeline;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await appendLog(logFile, `[pipeline] failed to load override pipeline '${name}': ${msg}\n`);
      return undefined;
    }
  }

  private getHandler(action: string): NodeHandler {
    const handler = NODE_HANDLERS[action];
    if (!handler) {
      throw new Error(`No handler registered for action: ${action}`);
    }
    return handler;
  }

  /**
   * Write ~/.pi/agent/models.json inside the sandbox container.
   * Pi-agent auto-discovers this file and applies provider-level compat settings,
   * including openRouterRouting which gets passed as the `provider` field in
   * OpenRouter API requests.
   */
  private async writePiAgentModelsJson(
    containerId: string,
    providerPreferences: Record<string, unknown>,
    logFile: string
  ): Promise<void> {
    if (!this.containerManager) return;

    const modelsJson = JSON.stringify({
      providers: {
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "OPENROUTER_API_KEY",
          api: "openai-completions",
          compat: {
            openRouterRouting: providerPreferences
          }
        }
      }
    });

    try {
      await this.containerManager.exec(containerId, `mkdir -p /root/.pi/agent && cat > /root/.pi/agent/models.json << 'PIEOF'\n${modelsJson}\nPIEOF`, {});
      await appendLog(logFile, `[sandbox] wrote pi-agent models.json with provider preferences: ${JSON.stringify(providerPreferences)}\n`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await appendLog(logFile, `[sandbox] warning: failed to write models.json: ${msg}\n`);
    }
  }
}

/** Aggregate all _tokenUsage_* context bag entries into a single TokenUsage. */
export function aggregateTokenUsage(ctx: ContextBag): TokenUsage | null {
  let gateInput = 0;
  let gateOutput = 0;

  for (const key of ctx.keys()) {
    if (!key.startsWith("_tokenUsage_")) continue;
    const entry = ctx.get<{ input: number; output: number }>(key);
    if (!entry) continue;
    gateInput += entry.input;
    gateOutput += entry.output;
  }

  if (gateInput === 0 && gateOutput === 0) return null;

  return {
    qualityGateInputTokens: gateInput,
    qualityGateOutputTokens: gateOutput
  };
}
