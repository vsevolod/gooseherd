import type { IncomingMessage } from "node:http";
import { parseCookies } from "./auth.js";
import type {
  DashboardAuthSessionStore,
  DashboardSessionAuthMethod,
  DashboardSessionRecord,
} from "./auth-session-store.js";

export interface DashboardUserActorPrincipal {
  principalType: "user";
  sessionId: string;
  authMethod: DashboardSessionAuthMethod;
  userId: string;
}

export interface DashboardAdminActorPrincipal {
  principalType: "admin_session";
  sessionId: string;
  authMethod: "admin_password";
}

export type DashboardActorPrincipal = DashboardUserActorPrincipal | DashboardAdminActorPrincipal;

type DashboardActorSessionStore = Pick<DashboardAuthSessionStore, "getSessionByToken">;

function toDashboardActorPrincipal(session: DashboardSessionRecord): DashboardActorPrincipal | undefined {
  if (session.principalType === "user") {
    if (!session.userId) return undefined;
    return {
      principalType: "user",
      sessionId: session.id,
      authMethod: session.authMethod,
      userId: session.userId,
    };
  }

  if (session.principalType === "admin") {
    return {
      principalType: "admin_session",
      sessionId: session.id,
      authMethod: "admin_password",
    };
  }

  return undefined;
}

export async function resolveDashboardActorPrincipal(
  req: IncomingMessage,
  sessionStore?: DashboardActorSessionStore,
): Promise<DashboardActorPrincipal | undefined> {
  if (!sessionStore) return undefined;

  const cookies = parseCookies(req);
  const sessionToken = cookies["gooseherd-session"];
  if (!sessionToken) return undefined;

  const session = await sessionStore.getSessionByToken(sessionToken);
  if (!session) return undefined;

  return toDashboardActorPrincipal(session);
}

export function isDashboardAdminPrincipal(
  principal: DashboardActorPrincipal | undefined,
): principal is DashboardAdminActorPrincipal {
  return principal?.principalType === "admin_session";
}

export function requireDashboardUserActor(
  principal: DashboardActorPrincipal | undefined,
): DashboardUserActorPrincipal {
  if (!principal) {
    throw new Error("Dashboard user actor is required");
  }

  if (isDashboardAdminPrincipal(principal)) {
    throw new Error("Admin dashboard sessions are not allowed here");
  }

  return principal;
}
