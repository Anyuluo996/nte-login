import {
  htmlResponse,
  jsonResponse,
  readConfig,
  requestPayload,
} from "./protocol";
import { LoginSessionDurableObject } from "./session";
import { renderLoginPage } from "./template";
import type { Env } from "./types";

export { LoginSessionDurableObject };

const POST_ROUTES = new Set([
  "/nte/start",
  "/nte/sendSmsCode",
  "/nte/login",
  "/nte/wanmei/prepare",
  "/nte/wanmei/sendSmsCode",
  "/nte/wanmei/login",
  "/nte/wanmei/selectRole",
]);

function pathAuth(path: string): string | null {
  const match = path.match(/^\/nte\/(?:i|status)\/([^/]+)$/);
  if (match?.[1] === undefined) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function validAuth(auth: string): boolean {
  return auth.length >= 4 && auth.length <= 64;
}

async function requestAuth(request: Request): Promise<string | null> {
  const payload = await requestPayload(request.clone());
  return payload !== null && typeof payload.auth === "string"
    ? payload.auth
    : null;
}

async function routeToSession(
  request: Request,
  env: Env,
  auth: string,
): Promise<Response> {
  if (!validAuth(auth)) return jsonResponse({ detail: "bad_request" }, 400);
  const objectId = env.LOGIN_SESSIONS.idFromName(auth);
  return env.LOGIN_SESSIONS.get(objectId).fetch(request);
}

export default {
  async fetch(request, env): Promise<Response> {
    if (env.SHARED_SECRET?.trim() === "" || env.SHARED_SECRET === undefined) {
      return jsonResponse({ detail: "shared_secret_not_configured" }, 500);
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/nte/done") {
      const config = readConfig(env);
      return htmlResponse(renderLoginPage("", "", config.sessionTtlS, true));
    }

    if (request.method === "GET") {
      const auth = pathAuth(url.pathname);
      if (auth !== null) return routeToSession(request, env, auth);
      return new Response("Not Found", { status: 404 });
    }

    if (request.method === "POST" && POST_ROUTES.has(url.pathname)) {
      const auth = await requestAuth(request);
      if (auth === null) return jsonResponse({ detail: "bad_request" }, 400);
      return routeToSession(request, env, auth);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
