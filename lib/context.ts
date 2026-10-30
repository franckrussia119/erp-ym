import { AsyncLocalStorage } from "async_hooks";

// Contexte de la requête en cours (utilisateur connecté), accessible depuis les hooks Prisma.
export const requestContext = new AsyncLocalStorage<{ req: any }>();

export function currentUserId(): number | null {
  const store = requestContext.getStore();
  return store?.req?.session?.userId ?? null;
}

export function baseUrl(): string {
  const env = (process.env.APP_URL || "").replace(/\/$/, "");
  if (env) return env;
  const req = requestContext.getStore()?.req;
  if (req) return `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
  return "";
}
