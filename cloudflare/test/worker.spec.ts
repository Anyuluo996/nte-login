import { env } from "cloudflare:workers";
import {
  runInDurableObject,
  runDurableObjectAlarm,
  SELF,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { aesEcbEncryptBase64, md5Hex } from "../src/sdk";
import type { Env, LoginSession } from "../src/types";

const TEST_SECRET = "test-secret";
const workerEnv = env as unknown as Env;

async function sign(parts: string[]): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TEST_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const result = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(parts.join("|")),
  );
  return Array.from(new Uint8Array(result), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function startSession(
  auth: string,
  userId = "user-1",
): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000);
  return SELF.fetch("https://nte-login.test/nte/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      auth,
      user_id: userId,
      bot_id: "onebot",
      group_id: null,
      ts: timestamp,
      sig: await sign(["start", auth, userId, String(timestamp)]),
    }),
  });
}

async function statusResponse(auth: string): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await sign(["listen", auth, String(timestamp)]);
  return SELF.fetch(
    `https://nte-login.test/nte/status/${auth}?ts=${timestamp}&sig=${signature}`,
  );
}

async function seedSession(
  auth: string,
  overrides: Partial<LoginSession> = {},
): Promise<DurableObjectStub> {
  const objectId = workerEnv.LOGIN_SESSIONS.idFromName(auth);
  const stub = workerEnv.LOGIN_SESSIONS.get(objectId);
  await runInDurableObject(stub, async (_instance, state) => {
    const session: LoginSession = {
      auth,
      user_id: "user-1",
      bot_id: "onebot",
      group_id: null,
      device: {
        device_id: "HT00000000000000",
        device_type: "Pixel 6",
        device_model: "Pixel 6",
        device_name: "Pixel 6",
        device_sys: "Android 14",
        adm: "HT00000000000000",
        imei: "",
        idfa: "",
        mac: "",
      },
      status: "pending",
      msg: "",
      credential: null,
      wanmei: null,
      tajiduo_sms_sent_at: null,
      wanmei_sms_sent_at: null,
      expires_at: Date.now() + 600_000,
      ...overrides,
    };
    await state.storage.put("session", session);
    await state.storage.setAlarm(session.expires_at);
  });
  return stub;
}

describe("Cloudflare Worker protocol", () => {
  it("rejects an invalid start signature", async () => {
    const response = await SELF.fetch("https://nte-login.test/nte/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth: "auth-bad-signature",
        user_id: "user-1",
        ts: Math.floor(Date.now() / 1000),
        sig: "bad",
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ detail: "bad_signature" });
  });

  it("creates an isolated session and serves the compatible login page", async () => {
    const auth = "auth-page";
    const start = await startSession(auth, "visible-user");
    expect(start.status).toBe(200);
    await expect(start.json()).resolves.toEqual({ auth, expires_in_s: 600 });

    const page = await SELF.fetch(`https://nte-login.test/nte/i/${auth}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(await page.text()).toContain("会话 visible-user");

    const pending = await statusResponse(auth);
    await expect(pending.json()).resolves.toEqual({
      status: "pending",
      msg: "",
      credential: null,
    });

    const missing = await statusResponse("auth-other");
    await expect(missing.json()).resolves.toEqual({
      status: "expired",
      msg: "",
      credential: null,
    });
  });

  it("keeps start idempotent for an existing auth", async () => {
    const auth = "auth-idempotent";
    expect((await startSession(auth, "first-user")).status).toBe(200);
    expect((await startSession(auth, "second-user")).status).toBe(200);

    const page = await SELF.fetch(`https://nte-login.test/nte/i/${auth}`);
    const html = await page.text();
    expect(html).toContain("会话 first-user");
    expect(html).not.toContain("会话 second-user");
  });

  it("consumes a terminal credential exactly once", async () => {
    const auth = "auth-consume";
    await seedSession(auth, {
      status: "success",
      msg: "登录成功",
      credential: {
        kind: "tajiduo",
        laohu_token: "test-token",
        laohu_user_id: "123",
      },
    });

    const responses = await Promise.all([
      statusResponse(auth),
      statusResponse(auth),
    ]);
    const payloads = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(payloads).toContainEqual({
      status: "success",
      msg: "登录成功",
      credential: {
        kind: "tajiduo",
        laohu_token: "test-token",
        laohu_user_id: "123",
      },
    });
    expect(payloads).toContainEqual({
      status: "expired",
      msg: "",
      credential: null,
    });

    const consumed = await statusResponse(auth);
    await expect(consumed.json()).resolves.toEqual({
      status: "expired",
      msg: "",
      credential: null,
    });
  });

  it("removes expired credentials when the Durable Object alarm fires", async () => {
    const auth = "auth-alarm";
    const stub = await seedSession(auth, {
      expires_at: Date.now() - 1,
    });

    // A past-due alarm may run immediately in Miniflare; force it when still pending.
    await runDurableObjectAlarm(stub);
    const page = await SELF.fetch(`https://nte-login.test/nte/i/${auth}`);
    expect(page.status).toBe(404);
    await expect(
      statusResponse(auth).then((response) => response.json()),
    ).resolves.toEqual({
      status: "expired",
      msg: "",
      credential: null,
    });
  });

  it("rejects malformed requests before creating a session", async () => {
    const response = await SELF.fetch("https://nte-login.test/nte/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ detail: "bad_request" });
  });
});

describe("protocol crypto parity", () => {
  it("matches standard MD5 vectors", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
  });

  it("matches AES-128-ECB PKCS7 output", async () => {
    const key = new TextEncoder().encode("0123456789abcdef");
    await expect(aesEcbEncryptBase64(key, "13800138000")).resolves.toBe(
      "8fIrGTYAQzFR+tN2Wt0yDQ==",
    );
  });
});
