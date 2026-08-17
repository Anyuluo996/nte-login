import type {
  Config,
  Env,
  JsonRecord,
  LaohuDevice,
  StartPayload,
} from "./types";

const LAOHU_APP_ID = "10550";
const LAOHU_APP_KEY = "89155cc4e8634ec5b1b6364013b23e3e";

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum)
    return fallback;
  return parsed;
}

export function readConfig(env: Env): Config {
  return {
    sharedSecret: env.SHARED_SECRET?.trim() ?? "",
    laohuAppId: LAOHU_APP_ID,
    laohuAppKey: LAOHU_APP_KEY,
    sessionTtlS: boundedInteger(env.SESSION_TTL_S, 600, 60, 3600),
    sigTtlS: boundedInteger(env.SIG_TTL_S, 300, 30, 3600),
    smsCooldownS: boundedInteger(env.SMS_COOLDOWN_S, 60, 0, 600),
  };
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function requestPayload(
  request: Request,
): Promise<JsonRecord | null> {
  try {
    const value: unknown = await request.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function constantTimeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function verifySignature(
  secret: string,
  parts: string[],
  expected: string,
  timestamp: number,
  ttlS: number,
): Promise<boolean> {
  // 底层协议保留 Python / EdgeOne 的空 secret 语义；Cloudflare 入口会要求配置 secret。
  if (secret === "") return true;
  if (expected === "" || !Number.isInteger(timestamp)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > ttlS) return false;
  const actual = await hmacSha256Hex(secret, parts.join("|"));
  return constantTimeEqualHex(actual, expected);
}

export async function verifyStart(
  payload: StartPayload,
  config: Config,
): Promise<boolean> {
  return verifySignature(
    config.sharedSecret,
    ["start", payload.auth, payload.user_id, String(payload.ts)],
    payload.sig ?? "",
    payload.ts,
    config.sigTtlS,
  );
}

export async function verifyListen(
  auth: string,
  timestamp: number,
  signature: string,
  config: Config,
): Promise<boolean> {
  return verifySignature(
    config.sharedSecret,
    ["listen", auth, String(timestamp)],
    signature,
    timestamp,
    config.sigTtlS,
  );
}

export function newDevice(): LaohuDevice {
  const random = new Uint8Array(7);
  crypto.getRandomValues(random);
  const deviceId = `HT${Array.from(random, (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase()}`;
  return {
    device_id: deviceId,
    device_type: "Pixel 6",
    device_model: "Pixel 6",
    device_name: "Pixel 6",
    device_sys: "Android 14",
    adm: deviceId,
    imei: "",
    idfa: "",
    mac: "",
  };
}

export function isStartPayload(payload: JsonRecord): payload is StartPayload {
  return (
    typeof payload.auth === "string" &&
    payload.auth.length >= 4 &&
    payload.auth.length <= 64 &&
    typeof payload.user_id === "string" &&
    payload.user_id.length >= 1 &&
    payload.user_id.length <= 64 &&
    (payload.bot_id === undefined ||
      (typeof payload.bot_id === "string" && payload.bot_id.length <= 64)) &&
    (payload.group_id === undefined ||
      payload.group_id === null ||
      (typeof payload.group_id === "string" &&
        payload.group_id.length <= 64)) &&
    Number.isInteger(payload.ts) &&
    (payload.sig === undefined || typeof payload.sig === "string")
  );
}

export function cooldownRemainingS(
  lastSentAt: number | null,
  cooldownS: number,
): number {
  if (lastSentAt === null || cooldownS <= 0) return 0;
  const elapsedMs = Date.now() - lastSentAt;
  return Math.max(0, Math.ceil((cooldownS * 1000 - elapsedMs) / 1000));
}
