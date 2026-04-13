import type { IncomingMessage } from "node:http";
import type { ControlPlaneStore } from "./control-plane-store.js";

export async function authenticateRunnerRequest(
  req: IncomingMessage,
  store: ControlPlaneStore,
  runId: string
): Promise<boolean> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token) return false;
  return store.validateRunToken(runId, token);
}
