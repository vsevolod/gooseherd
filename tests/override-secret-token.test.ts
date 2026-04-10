import assert from "node:assert/strict";
import test from "node:test";
import { overrideManifestRunToken } from "../scripts/kubernetes/override-secret-token.ts";

test("overrideManifestRunToken replaces the secret RUN_TOKEN value in the manifest", () => {
  const manifest = [
    "apiVersion: v1",
    "kind: Secret",
    "stringData:",
    "  RUN_TOKEN: \"original-token\"",
    "---",
    "apiVersion: batch/v1",
  ].join("\n");

  const updated = overrideManifestRunToken(manifest, "invalid-token");

  assert.match(updated, /RUN_TOKEN: "invalid-token"/);
  assert.doesNotMatch(updated, /RUN_TOKEN: "original-token"/);
});

test("overrideManifestRunToken fails when RUN_TOKEN is missing from the manifest", () => {
  assert.throws(
    () => overrideManifestRunToken("apiVersion: v1\nkind: Secret\nstringData:\n", "invalid-token"),
    /RUN_TOKEN/,
  );
});
