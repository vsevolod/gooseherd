import assert from "node:assert/strict";
import test from "node:test";
import { KubernetesRuntimeFactsReader } from "../src/runtime/kubernetes/runtime-facts.js";

test("kubernetes runtime facts reader reports succeeded from job conditions", async () => {
  const reader = new KubernetesRuntimeFactsReader({
    namespace: "gooseherd",
    resourceClient: {
      readJob: async () => ({ status: { conditions: [{ type: "Complete", status: "True" }] } }),
      listPodsForJob: async () => [],
    },
  });

  await assert.strictEqual(
    await reader.getTerminalFact("12345678-1234-5678-9abc-def012345678"),
    "succeeded",
  );
});

test("kubernetes runtime facts reader reports failed for image pull backoff pods", async () => {
  const reader = new KubernetesRuntimeFactsReader({
    namespace: "gooseherd",
    resourceClient: {
      readJob: async () => ({ status: {} }),
      listPodsForJob: async () => [
        {
          status: {
            phase: "Pending",
            containerStatuses: [
              {
                state: {
                  waiting: {
                    reason: "ImagePullBackOff",
                  },
                },
              },
            ],
          },
        },
      ],
    },
  });

  await assert.strictEqual(
    await reader.getTerminalFact("12345678-1234-5678-9abc-def012345678"),
    "failed",
  );
});
