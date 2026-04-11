import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../src/config.js";
import { startDashboardServer, type DashboardWorkItemsSource } from "../src/dashboard-server.js";
import { RunStore } from "../src/store.js";
import { createTestDb } from "./helpers/test-db.js";
import { teams, users } from "../src/db/schema.js";
import { WorkItemStore } from "../src/work-items/store.js";
import { ReviewRequestStore } from "../src/work-items/review-request-store.js";
import { WorkItemEventsStore } from "../src/work-items/events-store.js";
import { WorkItemService } from "../src/work-items/service.js";

let nextPort = 30500 + Math.floor(Math.random() * 1000);
function getPort(): number {
  return nextPort++;
}

function makeConfig(port: number, dataDir: string): AppConfig {
  return {
    appName: "test",
    appSlug: "test",
    slackCommandName: "/goose",
    slackAllowedChannels: [],
    repoAllowlist: [],
    runnerConcurrency: 1,
    workRoot: dataDir,
    dataDir,
    dryRun: false,
    branchPrefix: "goose/",
    defaultBaseBranch: "main",
    gitAuthorName: "Test",
    gitAuthorEmail: "test@test.com",
    agentCommandTemplate: "echo dummy-agent",
    validationCommand: "true",
    lintFixCommand: "true",
    localTestCommand: "true",
    maxValidationRounds: 3,
    agentTimeoutSeconds: 300,
    slackProgressHeartbeatSeconds: 30,
    dashboardEnabled: true,
    dashboardHost: "127.0.0.1",
    dashboardPort: port,
    maxTaskChars: 10000,
    workspaceCleanupEnabled: false,
    workspaceMaxAgeHours: 24,
    workspaceCleanupIntervalMinutes: 60,
    cemsEnabled: false,
    mcpExtensions: [],
    piAgentExtensions: [],
    pipelineFile: "pipelines/default.yml",
    observerEnabled: false,
    observerAlertChannelId: "",
    observerMaxRunsPerDay: 10,
    observerMaxRunsPerRepoPerDay: 5,
    observerCooldownMinutes: 10,
    observerRulesFile: "observer-rules.yml",
    observerRepoMap: new Map(),
    observerSlackWatchedChannels: [],
    observerSlackBotAllowlist: [],
    observerSentryPollIntervalSeconds: 300,
    observerWebhookPort: 0,
    observerWebhookSecrets: {},
    observerGithubPollIntervalSeconds: 300,
    observerGithubWatchedRepos: [],
    defaultLlmModel: "test",
    planTaskModel: "test",
    scopeJudgeEnabled: false,
    scopeJudgeModel: "test",
    scopeJudgeMinPassScore: 1,
    orchestratorModel: "test",
    orchestratorTimeoutMs: 30000,
    orchestratorWallClockTimeoutMs: 60000,
    autonomousSchedulerEnabled: false,
    autonomousSchedulerMaxDeferred: 100,
    autonomousSchedulerIntervalMs: 300_000,
    observerSmartTriageEnabled: false,
    observerSmartTriageModel: "test",
    observerSmartTriageTimeoutMs: 30000,
    browserVerifyEnabled: false,
    screenshotEnabled: false,
    browserVerifyModel: "test",
    browserVerifyMaxSteps: 10,
    browserVerifyExecTimeoutMs: 60000,
    ciWaitEnabled: false,
    ciPollIntervalSeconds: 30,
    ciPatienceTimeoutSeconds: 120,
    ciMaxWaitSeconds: 600,
    ciCheckFilter: [],
    ciMaxFixRounds: 3,
    featureDeliveryResetEngineeringReviewOnNewCommits: false,
    featureDeliveryResetQaReviewOnNewCommits: false,
    workItemGithubAdoptionLabels: ["ai_flow"],
    teamChannelMap: new Map(),
    sandboxRuntime: "local",
    sandboxRuntimeExplicit: false,
    sandboxEnabled: false,
    sandboxImage: "node:20-slim",
    sandboxHostWorkPath: "",
    sandboxCpus: 1,
    sandboxMemoryMb: 512,
    supervisorEnabled: false,
    supervisorRunTimeoutSeconds: 3600,
    supervisorNodeStaleSeconds: 600,
    supervisorWatchdogIntervalSeconds: 30,
    supervisorMaxAutoRetries: 2,
    supervisorRetryCooldownSeconds: 60,
    supervisorMaxRetriesPerDay: 5,
    databaseUrl: "postgres://gooseherd:gooseherd@postgres:5432/gooseherd_test",
  } as AppConfig;
}

function createMockRunDatabase() {
  const query = {
    where() { return this; },
    orderBy() { return this; },
    limit() { return Promise.resolve([]); },
  };

  return {
    select() {
      return {
        from() {
          return query;
        },
      };
    },
  };
}

async function request(port: number, method: string, pathname: string): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathname, method },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data: Record<string, unknown>;
          try { data = JSON.parse(text); } catch { data = { raw: text }; }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitForServer(port: number, maxMs = 3000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, "GET", "/healthz");
      if (res.status === 200) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Server did not start in time");
}

describe("Dashboard Work Item API routes", () => {
  const servers: http.Server[] = [];
  const tmpDirs: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    servers.length = 0;

    for (const cleanup of cleanups) {
      await cleanup();
    }
    cleanups.length = 0;

    for (const dir of tmpDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  async function startServer(workItemsSource?: DashboardWorkItemsSource): Promise<number> {
    const port = getPort();
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gooseherd-dash-work-items-"));
    tmpDirs.push(tmpDir);
    const config = makeConfig(port, tmpDir);
    const runStore = new RunStore(createMockRunDatabase() as never);
    await runStore.init();
    const server = startDashboardServer(config, runStore, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, workItemsSource);
    servers.push(server);
    await waitForServer(port);
    return port;
  }

  async function createWorkItemsSource(): Promise<DashboardWorkItemsSource & { discoveryId: string }> {
    const testDb = await createTestDb();
    cleanups.push(testDb.cleanup);

    const pmUserId = randomUUID();
    const reviewerUserId = randomUUID();
    const ownerTeamId = randomUUID();

    await testDb.db.insert(users).values([
      { id: pmUserId, slackUserId: "U_PM", displayName: "PM" },
      { id: reviewerUserId, slackUserId: "U_REVIEW", displayName: "Reviewer" },
    ]);
    await testDb.db.insert(teams).values({
      id: ownerTeamId,
      name: "growth",
      slackChannelId: "C_GROWTH",
    });

    const service = new WorkItemService(testDb.db);
    const workItemStore = new WorkItemStore(testDb.db);
    const reviewRequestStore = new ReviewRequestStore(testDb.db);
    const eventsStore = new WorkItemEventsStore(testDb.db);

    const discovery = await service.createDiscoveryWorkItem({
      title: "Discovery item",
      summary: "Build a spec",
      ownerTeamId,
      homeChannelId: "C_GROWTH",
      homeThreadTs: "1740000000.900",
      createdByUserId: pmUserId,
    });
    await service.startDiscovery(discovery.id);
    await service.requestReview({
      workItemId: discovery.id,
      requestedByUserId: pmUserId,
      requests: [
        {
          type: "review",
          targetType: "user",
          targetRef: { userId: reviewerUserId },
          title: "Review discovery draft",
          requestMessage: "Please review",
          focusPoints: ["scope"],
        },
      ],
    });

    await service.createDeliveryFromJira({
      title: "Delivery item",
      summary: "Implement the feature",
      ownerTeamId,
      homeChannelId: "C_GROWTH",
      homeThreadTs: "1740000000.901",
      jiraIssueKey: "HBL-500",
      createdByUserId: pmUserId,
    });

    return {
      discoveryId: discovery.id,
      listWorkItems: async (workflow?: string) => {
        const items = await workItemStore.listWorkItems();
        return workflow ? items.filter((item) => item.workflow === workflow) : items;
      },
      getWorkItem: (id: string) => workItemStore.getWorkItem(id),
      listReviewRequestsForWorkItem: (workItemId: string) => reviewRequestStore.listReviewRequestsForWorkItem(workItemId),
      listEventsForWorkItem: (workItemId: string) => eventsStore.listForWorkItem(workItemId),
    };
  }

  test("GET /api/work-items returns 501 when source is unavailable", async () => {
    const port = await startServer(undefined);
    const res = await request(port, "GET", "/api/work-items");
    assert.equal(res.status, 501);
  });

  test("GET /api/work-items lists work items filtered by workflow", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source);

    const res = await request(port, "GET", "/api/work-items?workflow=product_discovery");
    assert.equal(res.status, 200);
    const items = res.data.workItems as Array<{ workflow: string }>;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.workflow, "product_discovery");
  });

  test("GET /api/work-items/:id returns work item detail", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source);

    const res = await request(port, "GET", `/api/work-items/${source.discoveryId}`);
    assert.equal(res.status, 200);
    assert.equal((res.data.workItem as { id: string }).id, source.discoveryId);
  });

  test("GET /api/work-items/:id/review-requests returns review requests", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source);

    const res = await request(port, "GET", `/api/work-items/${source.discoveryId}/review-requests`);
    assert.equal(res.status, 200);
    const requests = res.data.reviewRequests as Array<{ workItemId: string }>;
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.workItemId, source.discoveryId);
  });

  test("GET /api/work-items/:id/events returns work item events", async () => {
    const source = await createWorkItemsSource();
    const port = await startServer(source);

    const res = await request(port, "GET", `/api/work-items/${source.discoveryId}/events`);
    assert.equal(res.status, 200);
    const events = res.data.events as Array<{ workItemId: string }>;
    assert.ok(events.length >= 2);
    assert.equal(events[0]?.workItemId, source.discoveryId);
  });
});
