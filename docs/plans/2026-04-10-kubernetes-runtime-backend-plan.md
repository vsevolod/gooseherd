---
title: "feat: register a real kubernetes runtime backend"
type: feature
date: 2026-04-10
---

# feat: register a real kubernetes runtime backend

## Overview

The current Kubernetes work proves the runner / control-plane contract and validates it against `minikube`, but only through manual harness orchestration.

What is still missing is the actual product path:

- `RunManager` chooses runtime `kubernetes`
- Gooseherd itself creates the run-scoped Kubernetes resources
- Gooseherd waits for runtime completion
- Gooseherd derives final business state from runtime fact plus runner completion
- Gooseherd performs cleanup without external scripts

Until that exists, `SANDBOX_RUNTIME=kubernetes` is not a real runtime mode. It is only a tested contract.

## Goal

Implement a real `runtimeRegistry.kubernetes` backend so a normal Gooseherd run can execute on Kubernetes without manual `seed/apply/finalize/cleanup` scripts.

## First Product Slice

The first slice should stay narrow and map closely to what the harness already proved:

- one `Job` per `runId`
- one run token `Secret`
- runner pod fetches payload and reports completion through internal API
- Gooseherd polls Kubernetes runtime state
- Gooseherd reads runner completion from the control-plane store
- Gooseherd cleans up `Job` / `Pod` / `Secret`

This slice does **not** need to solve every long-term lifecycle abstraction issue before becoming usable.

## Constraints

### Existing interface constraint

`RunManager.processRun()` currently expects:

- select runtime backend
- call `backend.execute(run, ctx)`
- await one `ExecutionResult`
- mark run `completed` or `failed` itself

This is a synchronous contract shaped around `local` and `docker`.

For Kubernetes, the runner is a separate process inside a pod and reports semantic completion through the control-plane API. That means the current interface is not ideal, but we should avoid a full interface redesign as the first step unless absolutely necessary.

### Recommended approach for slice 1

Keep the existing `RunExecutionBackend` interface for now and implement Kubernetes backend as:

1. prepare control-plane state for the run
2. create Kubernetes resources
3. poll Kubernetes runtime facts until terminal
4. read latest control-plane completion
5. derive final outcome
6. cleanup Kubernetes resources
7. return `ExecutionResult` on semantic success, throw on failure/cancellation/infra failure

This keeps `RunManager` unchanged for the first product slice while still using the real runtime path.

## Scope

Included:

- real `KubernetesExecutionBackend`
- runtime registration in `src/index.ts`
- removing the explicit runtime-mode rejection for Kubernetes
- minimal local `minikube` support through `GOOSEHERD_INTERNAL_BASE_URL`
- explicit cleanup inside the backend
- focused tests for backend registration and run-manager dispatch

Excluded from this first slice:

- repo dependency topology resolution beyond what already works in the harness
- controller-style reconciliation daemon
- backend API redesign for long-running detached runtimes
- production-grade credential inventory integration

## Implementation Plan

### Task 1: Make Kubernetes a legal runtime mode

Update runtime-mode checks so Kubernetes is no longer rejected purely for being Kubernetes.

Files:
- `src/runtime/runtime-mode.ts`
- `tests/runtime-mode.test.ts`
- `tests/run-manager-sandbox-runtime.test.ts`

Expected behavior:
- `SANDBOX_RUNTIME=kubernetes` can be selected
- enqueue is no longer rejected just because runtime is Kubernetes
- rejection should happen only on real backend/config problems

### Task 2: Add a Kubernetes backend implementation

Create a backend, likely `src/runtime/kubernetes-backend.ts`, that:

- creates a run envelope if needed
- issues run token
- allocates deterministic artifact targets
- builds `Secret` + `Job` manifest
- applies resources via `kubectl`
- polls runtime state through `kubectl`
- reads latest completion from `ControlPlaneStore`
- translates semantic success to `ExecutionResult`
- throws on semantic failure / auth failure / missing completion / infra failure
- cleans up resources in a `finally` block when appropriate

Dependencies likely needed in constructor:

- `ControlPlaneStore`
- `RunnerArtifactStore`
- `RunStore`
- base URL config
- runner image config

### Task 3: Register the backend in the app

Wire the backend into:

- `src/index.ts`
- `src/local-trigger.ts` if applicable
- runtime typechecks/tests

Result:
- `runtimeRegistry.kubernetes` is no longer `undefined`

### Task 4: Add focused product-path tests

At minimum:

- `RunManager` dispatches to a registered Kubernetes backend
- Kubernetes runtime is accepted in sandbox runtime tests
- backend registration tests no longer expect `undefined`

If feasible in this slice:

- a backend unit test with fake `kubectl` executor and fake control-plane state

### Task 5: End-to-end proof on minikube

After registration:

- start Gooseherd with `SANDBOX_RUNTIME=kubernetes`
- enqueue a normal run through the application path
- verify it launches a `Job` without manual seed/apply/finalize steps
- confirm final run status in Gooseherd

## Acceptance Criteria

- `SANDBOX_RUNTIME=kubernetes` is accepted by config/runtime mode
- `runtimeRegistry.kubernetes` is a real backend
- a normal Gooseherd run can launch a Kubernetes `Job` through `RunManager`
- backend performs cleanup of `Job` / `Pod` / `Secret`
- no manual harness scripts are required for the basic success path

## Verification

Minimum verification for this slice:

- `node --test --test-force-exit --import tsx tests/runtime-mode.test.ts tests/run-manager-sandbox-runtime.test.ts tests/run-manager-runtime.test.ts`
- `npm run check`
- one real local product-path run against `minikube`
