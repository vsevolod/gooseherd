import assert from "node:assert/strict";
import test from "node:test";
import { resolveSmokeScenario } from "../scripts/kubernetes/seed-smoke-run.ts";

test("resolveSmokeScenario selects the cancel pipeline from scenario name when no pipeline file is provided", () => {
  assert.deepEqual(resolveSmokeScenario(undefined, "cancel"), {
    pipelineFile: "pipelines/kubernetes-cancel-smoke.yml",
    scenarioName: "cancel",
  });
});

test("resolveSmokeScenario selects the failure pipeline from scenario name when no pipeline file is provided", () => {
  assert.deepEqual(resolveSmokeScenario(undefined, "failure"), {
    pipelineFile: "pipelines/kubernetes-fail-smoke.yml",
    scenarioName: "failure",
  });
});

test("resolveSmokeScenario keeps an explicit pipeline file", () => {
  assert.deepEqual(resolveSmokeScenario("pipelines/custom.yml", "custom"), {
    pipelineFile: "pipelines/custom.yml",
    scenarioName: "custom",
  });
});

test("resolveSmokeScenario falls back to the default smoke scenario", () => {
  assert.deepEqual(resolveSmokeScenario(undefined, undefined), {
    pipelineFile: "pipelines/kubernetes-smoke.yml",
    scenarioName: "smoke",
  });
});
