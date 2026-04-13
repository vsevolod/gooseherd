import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { IncomingMessage } from "node:http";

import {
  resolveDashboardActorPrincipal,
  requireDashboardUserActor,
} from "../src/dashboard/actor-principal.js";

function makeMockReq(cookie?: string): IncomingMessage {
  return {
    headers: cookie ? { cookie } : {},
  } as unknown as IncomingMessage;
}

test("user session resolves to a user dashboard principal", async () => {
  const req = makeMockReq("gooseherd-session=session-token");
  const sessionStore = {
    getSessionByToken: mock.fn(async (token: string) => token === "session-token"
      ? {
        id: "sess-1",
        principalType: "user",
        authMethod: "slack",
        userId: "user-123",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        lastSeenAt: new Date().toISOString(),
      }
      : undefined),
  } as const;

  const principal = await resolveDashboardActorPrincipal(req, sessionStore);

  assert.deepEqual(principal, {
    principalType: "user",
    sessionId: "sess-1",
    authMethod: "slack",
    userId: "user-123",
  });
});

test("admin password session resolves to an admin_session principal", async () => {
  const req = makeMockReq("gooseherd-session=session-token");
  const sessionStore = {
    getSessionByToken: mock.fn(async (token: string) => token === "session-token"
      ? {
        id: "sess-admin",
        principalType: "admin",
        authMethod: "admin_password",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        lastSeenAt: new Date().toISOString(),
      }
      : undefined),
  } as const;

  const principal = await resolveDashboardActorPrincipal(req, sessionStore);

  assert.deepEqual(principal, {
    principalType: "admin_session",
    sessionId: "sess-admin",
    authMethod: "admin_password",
  });
});

test("requireDashboardUserActor rejects admin_session principals", () => {
  assert.throws(
    () => requireDashboardUserActor({
      principalType: "admin_session",
      sessionId: "sess-admin",
      authMethod: "admin_password",
    }),
    /admin/i,
  );
});
