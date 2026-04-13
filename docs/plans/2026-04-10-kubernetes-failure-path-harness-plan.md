---
title: "feat: add Kubernetes failure-path e2e coverage for the local harness"
type: feature
date: 2026-04-10
---

# feat: add Kubernetes failure-path e2e coverage for the local harness

## Overview

Stage 2 currently validates three local Kubernetes paths against `minikube`:

- success
- cancellation
- Kubernetes resource cleanup

What is still missing is end-to-end evidence that the current harness behaves correctly when the runner fails normally, not because of a user cancellation. The next slice should add deterministic failure-path coverage to the same local harness before moving on to harder infra failures like auth rejection, control-plane unavailability, or `ImagePullBackOff`.

## Goal

Extend the existing local Kubernetes harness so it can validate the first real failure-path scenario:

- runner starts successfully
- pipeline fails deterministically inside the pod
- control-plane receives a failed completion
- reconciliation finalizes the run as `failed`
- cleanup still removes `Job` / `Pod` / `Secret`

## Why This Slice First

This is the highest-signal next scenario with the least churn:

- it exercises the same real pod + runner + control-plane path as success/cancel
- it is fully deterministic
- it does not require breaking networking, token issuance, or image resolution artificially
- it proves that “ordinary failure” is distinct from “cancelled”

Once this path is green, we can move to harsher infrastructure failures with more confidence in the baseline runtime semantics.

## Scope

Included in this slice:

- one deterministic failing pipeline for the Kubernetes harness
- one new harness scenario, likely `failure`
- assertions that final run status is `failed`
- cleanup assertions after failure terminal state
- focused regression tests for any new scenario-selection or helper logic

Not included in this slice:

- invalid token / unauthorized runner scenarios
- temporary control-plane outage scenarios
- image pull failures / unschedulable pods
- automatic retries or chaos-style multi-failure orchestration

## Proposed Scenario Order

### 1. Deterministic Runner Failure

Add a pipeline such as `pipelines/kubernetes-fail-smoke.yml` that:

- starts the runner normally
- executes a deterministic command that exits non-zero
- produces a failed completion without cancellation

Harness expectations:

- `kubectl wait --for=condition=failed job/...`
- final reconciled run status is `failed`
- cleanup removes `Job`, owned `Pod`, and `Secret`

### 2. Invalid / Missing Token

After the first failure path is stable:

- mutate the per-run secret or token before the pod starts
- expect runner bootstrap failure
- assert terminal failure and cleanup

### 3. Control-Plane Unreachable

Then:

- point `GOOSEHERD_INTERNAL_BASE_URL` at a blackhole or stop Gooseherd after scheduling
- expect runner retries and eventual failure
- assert final failure semantics and cleanup

### 4. Kubernetes Scheduling / Image Failure

Finally:

- invalid image tag or pull policy mismatch
- unschedulable resource constraints
- assert harness failure output is explicit and resources still clean up when possible

## Implementation Plan For This Slice

### Step 1: Add the failing pipeline asset

Create `pipelines/kubernetes-fail-smoke.yml` with a minimal deterministic command like:

```yml
version: 1
name: "kubernetes-fail-smoke"
nodes:
  - id: fail
    type: deterministic
    action: run
    config:
      command: "sh -lc 'echo intentional failure >&2; exit 1'"
```

### Step 2: Add harness support for a `failure` scenario

Update `scripts/kubernetes/manual-harness.sh` to:

- seed a `failure` scenario
- apply the manifest
- wait for `job/...` to reach `condition=failed`
- finalize with runtime fact `failed`
- assert final run status is `failed`
- run cleanup and cleanup assertions

### Step 3: Add focused regression coverage

Use TDD for any helper logic added around scenario resolution or harness orchestration. For this slice that most likely means:

- scenario-to-pipeline resolution tests if the failure scenario is made discoverable through `seed-smoke-run.ts`
- shell syntax checks remain part of verification

### Step 4: Run the full local harness

Primary proof command:

```bash
MINIKUBE_BUILD_IN_NODE=1 npm run k8s:harness
```

Expected:

- success passes
- cancel passes
- failure passes
- namespace is clean afterwards

## Acceptance Criteria

- local harness includes a deterministic non-cancel failure-path
- failure scenario finalizes to run status `failed`
- cancellation scenario still finalizes to `cancelled`
- success scenario still finalizes to `completed`
- cleanup succeeds after all three scenarios
- `kubectl get jobs,pods,secrets` is empty after the harness completes

## Verification

At minimum for this slice:

- `bash -n scripts/kubernetes/manual-harness.sh scripts/kubernetes/build-runner-image.sh`
- `node --test --test-force-exit --import tsx tests/seed-smoke-run.test.ts` if scenario resolution changes
- `node --test --test-force-exit --import tsx tests/runner-index.test.ts tests/kubernetes-job-spec.test.ts`
- `docker compose run --rm -T -e DATABASE_URL_TEST=postgres://gooseherd:gooseherd@postgres:5432/gooseherd_test -v "$PWD:/app" --entrypoint sh gooseherd -lc 'cd /app && node --test --test-force-exit --import tsx tests/control-plane-store.test.ts'`
- `npm run check`
- `MINIKUBE_BUILD_IN_NODE=1 npm run k8s:harness`
