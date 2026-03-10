/**
 * Example plugin: adds an "echo" node handler that logs a message.
 * Demonstrates the Gooseherd plugin system (Phase 5).
 */
import { appendFile } from "node:fs/promises";

async function echoNode(nodeConfig, ctx, deps) {
  const nc = nodeConfig.config;
  const message = nc?.message ?? "Hello from echo plugin!";
  const runId = deps.run.id;

  // Log to run log file
  await appendFile(deps.logFile, `[echo-plugin] ${message} (run: ${runId})\n`);

  // Store in context bag for downstream nodes
  ctx.set("echo_output", message);

  return {
    outcome: "success",
    outputs: { echo_message: message },
  };
}

const plugin = {
  name: "echo-plugin",
  version: "1.0.0",
  nodeHandlers: {
    echo: echoNode,
  },
};

export default plugin;
