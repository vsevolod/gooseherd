import assert from "node:assert/strict";
import test from "node:test";
import { overrideManifestInternalBaseUrl } from "../scripts/kubernetes/override-internal-base-url.ts";

test("overrideManifestInternalBaseUrl replaces GOOSEHERD_INTERNAL_BASE_URL in the manifest", () => {
  const manifest = [
    "env:",
    "  - name: GOOSEHERD_INTERNAL_BASE_URL",
    "    value: \"http://host.minikube.internal:8787\"",
    "  - name: RUN_ID",
    "    value: \"run-1\"",
  ].join("\n");

  const updated = overrideManifestInternalBaseUrl(manifest, "http://host.minikube.internal:1");

  assert.match(updated, /value: "http:\/\/host\.minikube\.internal:1"/);
  assert.doesNotMatch(updated, /value: "http:\/\/host\.minikube\.internal:8787"/);
});

test("overrideManifestInternalBaseUrl fails when the variable is missing", () => {
  assert.throws(
    () => overrideManifestInternalBaseUrl("env:\n  - name: RUN_ID\n    value: \"run-1\"\n", "http://host.minikube.internal:1"),
    /GOOSEHERD_INTERNAL_BASE_URL/,
  );
});
