# Kubernetes-Native API Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `kubectl` shell-outs in the Kubernetes runtime backend with direct Kubernetes API calls while preserving the current one-`Job`-per-run execution model.

**Architecture:** Keep the current Gooseherd control-plane and runner contract unchanged. Introduce a small Kubernetes resource client abstraction for `Secret`, `Job`, `Pod`, and log operations, then refactor `KubernetesExecutionBackend` to depend on that abstraction instead of `execFile("kubectl", ...)`. Verify the same flow on `minikube`.

**Tech Stack:** TypeScript, Node.js, `@kubernetes/client-node`, Node test runner, `tsx`, PostgreSQL/Drizzle, `minikube`

---

### Task 1: Plan And Dependency Setup

**Files:**
- Create: `docs/plans/2026-04-10-kubernetes-native-api-migration-plan.md`
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] Add the official Kubernetes Node client dependency.
- [x] Keep the scope minimal: no CRD, no operator, no runtime model change, no new env vars.
- [x] Commit after dependency changes only if the install and typecheck pass.

### Task 2: Kubernetes Resource Client Abstraction

**Files:**
- Create: `src/runtime/kubernetes/resource-client.ts`
- Test: `tests/kubernetes-resource-client.test.ts`

- [x] Define a focused interface for the backend needs only:
  - `applySecret(manifest)`
  - `applyJob(manifest)`
  - `readJob(name, namespace)`
  - `listPodsForJob(jobName, namespace)`
  - `readJobLogs(jobName, namespace)`
  - `deleteJob(name, namespace)`
  - `deletePodsForJob(jobName, namespace)`
  - `deleteSecret(name, namespace)`
- [x] Provide one real implementation backed by `@kubernetes/client-node`.
- [x] Keep all Kubernetes library details out of `kubernetes-backend.ts`.
- [x] Add unit tests around the abstraction boundary with fakes rather than hitting a real cluster.

### Task 3: Backend Refactor From `kubectl` To API Calls

**Files:**
- Modify: `src/runtime/kubernetes-backend.ts`
- Modify: `tests/kubernetes-backend.test.ts`
- Modify: `src/index.ts`
- Modify: `src/local-trigger.ts`

- [x] Remove `execFile`/`kubectlCommand`/`kubectl(args)` plumbing from the backend.
- [x] Inject the new resource client abstraction instead.
- [x] Preserve existing behavior:
  - manifest generation still uses `buildRunTokenSecretManifest` and `buildRunJobSpec`
  - same terminal fact mapping
  - same log capture behavior
  - same cleanup ordering
  - same control-plane envelope/token/artifact flow
- [x] Update backend tests to assert resource-client method calls rather than `kubectl` argv sequences.

### Task 4: Docs And Deployment Assumptions

**Files:**
- Modify: `docs/installation-kubernetes.md`
- Modify: `README.md`

- [x] Remove guidance that the main app image must contain `kubectl`.
- [x] Replace it with the new assumption:
  - Gooseherd uses Kubernetes API credentials available to the process
  - the app needs network reachability to the Kubernetes API server
  - RBAC remains required
- [x] Keep the current caveat that the repo still does not ship a full Helm chart or deployment bundle.

### Task 5: Verification On Local Minikube

**Files:**
- Modify if needed: `tests/kubernetes-backend.test.ts`
- Modify if needed: `scripts/kubernetes/manual-smoke.sh`

- [x] Run focused local verification:
  - `npm run check`
  - `node --test --test-force-exit --import tsx tests/kubernetes-backend.test.ts tests/dashboard-pipelines.test.ts tests/runtime-mode.test.ts`
  - `docker compose run --rm -e DATABASE_URL_TEST=postgres://gooseherd:gooseherd@postgres:5432/gooseherd_test -v "$PWD:/app" --entrypoint sh gooseherd -lc 'cd /app && node --test --test-force-exit --import tsx tests/run-manager.test.ts tests/control-plane-store.test.ts'`
- [x] If the refactor is green, run one live `minikube` smoke check through the real backend path.
- [x] Document any remaining production gaps separately from this migration.
