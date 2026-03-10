/**
 * Tests for sandbox image resolver.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRepoSandboxImage } from "../src/sandbox/image-resolver.js";

// ── Helpers ──

async function makeTmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "img-resolver-"));
}

// ═══════════════════════════════════════════════════════
// resolveRepoSandboxImage
// ═══════════════════════════════════════════════════════

describe("resolveRepoSandboxImage", () => {
  test("returns default when no .gooseherd.yml exists", async () => {
    const repoDir = await makeTmpDir();
    try {
      const result = await resolveRepoSandboxImage(repoDir, "gooseherd/sandbox:default");
      assert.equal(result.image, "gooseherd/sandbox:default");
      assert.equal(result.source, "default");
      assert.equal(result.builtLocally, false);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("returns default when .gooseherd.yml has no sandbox section", async () => {
    const repoDir = await makeTmpDir();
    try {
      await writeFile(path.join(repoDir, ".gooseherd.yml"), "pipeline: hotfix\n", "utf8");
      const result = await resolveRepoSandboxImage(repoDir, "gooseherd/sandbox:default");
      assert.equal(result.image, "gooseherd/sandbox:default");
      assert.equal(result.source, "default");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("returns repo-configured image when sandbox.image is set", async () => {
    const repoDir = await makeTmpDir();
    try {
      await writeFile(
        path.join(repoDir, ".gooseherd.yml"),
        "sandbox:\n  image: ruby:3.3-slim\n",
        "utf8"
      );
      const result = await resolveRepoSandboxImage(repoDir, "gooseherd/sandbox:default");
      assert.equal(result.image, "ruby:3.3-slim");
      assert.equal(result.source, "repo_config");
      assert.equal(result.builtLocally, false);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("returns default when sandbox section is empty", async () => {
    const repoDir = await makeTmpDir();
    try {
      await writeFile(
        path.join(repoDir, ".gooseherd.yml"),
        "sandbox:\n  # no keys\n",
        "utf8"
      );
      const result = await resolveRepoSandboxImage(repoDir, "gooseherd/sandbox:default");
      assert.equal(result.image, "gooseherd/sandbox:default");
      assert.equal(result.source, "default");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("falls back to default when dockerfile path does not exist", async () => {
    const repoDir = await makeTmpDir();
    try {
      await writeFile(
        path.join(repoDir, ".gooseherd.yml"),
        "sandbox:\n  dockerfile: nonexistent/Dockerfile\n",
        "utf8"
      );
      const result = await resolveRepoSandboxImage(repoDir, "gooseherd/sandbox:default");
      assert.equal(result.image, "gooseherd/sandbox:default");
      assert.equal(result.source, "default");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("dockerfile takes priority over image", async () => {
    const repoDir = await makeTmpDir();
    try {
      // Create a Dockerfile that exists
      await writeFile(path.join(repoDir, "Dockerfile.sandbox"), "FROM alpine:3.19\n", "utf8");
      await writeFile(
        path.join(repoDir, ".gooseherd.yml"),
        "sandbox:\n  dockerfile: Dockerfile.sandbox\n  image: ruby:3.3\n",
        "utf8"
      );
      // Without a containerManager, it falls back to default (can't build)
      const result = await resolveRepoSandboxImage(repoDir, "gooseherd/sandbox:default");
      assert.equal(result.source, "default");
      assert.equal(result.image, "gooseherd/sandbox:default");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("dockerfile_inline falls back to default without container manager", async () => {
    const repoDir = await makeTmpDir();
    try {
      await writeFile(
        path.join(repoDir, ".gooseherd.yml"),
        'sandbox:\n  dockerfile_inline: "FROM alpine:3.19\\nRUN echo hello"\n',
        "utf8"
      );
      const result = await resolveRepoSandboxImage(repoDir, "gooseherd/sandbox:default");
      // Without containerManager, building falls back to default
      assert.equal(result.source, "default");
      assert.equal(result.image, "gooseherd/sandbox:default");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("handles malformed YAML gracefully", async () => {
    const repoDir = await makeTmpDir();
    try {
      await writeFile(
        path.join(repoDir, ".gooseherd.yml"),
        "sandbox: [invalid yaml structure",
        "utf8"
      );
      const result = await resolveRepoSandboxImage(repoDir, "gooseherd/sandbox:default");
      assert.equal(result.image, "gooseherd/sandbox:default");
      assert.equal(result.source, "default");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  test("inline dockerfile writes to .gooseherd-build directory", async () => {
    const repoDir = await makeTmpDir();
    try {
      await writeFile(
        path.join(repoDir, ".gooseherd.yml"),
        "sandbox:\n  dockerfile_inline: |\n    FROM alpine:3.19\n    RUN echo hello\n",
        "utf8"
      );
      // This will attempt to build but fail without containerManager
      const result = await resolveRepoSandboxImage(repoDir, "gooseherd/sandbox:default");
      assert.equal(result.source, "default");

      // Verify the temp Dockerfile was written
      const { readFile } = await import("node:fs/promises");
      const tmpDockerfile = path.join(repoDir, ".gooseherd-build", "Dockerfile");
      const content = await readFile(tmpDockerfile, "utf8");
      assert.ok(content.includes("FROM alpine:3.19"));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
