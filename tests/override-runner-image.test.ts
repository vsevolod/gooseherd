import assert from "node:assert/strict";
import test from "node:test";
import { overrideManifestRunnerImage } from "../scripts/kubernetes/override-runner-image.ts";

test("overrideManifestRunnerImage replaces the runner image in the manifest", () => {
  const manifest = [
    "containers:",
    "  - name: runner",
    "    image: gooseherd/k8s-runner:dev",
    "    imagePullPolicy: IfNotPresent",
  ].join("\n");

  const updated = overrideManifestRunnerImage(manifest, "this-image-should-not-exist.invalid/gooseherd:nope");

  assert.match(updated, /image: this-image-should-not-exist\.invalid\/gooseherd:nope/);
  assert.doesNotMatch(updated, /image: gooseherd\/k8s-runner:dev/);
});

test("overrideManifestRunnerImage fails when the runner image line is missing", () => {
  assert.throws(
    () => overrideManifestRunnerImage("containers:\n  - name: runner\n", "image:missing"),
    /runner image/,
  );
});
