import {
  cooldownRemainingS,
  htmlResponse,
  isStartPayload,
  jsonResponse,
  newDevice,
  readConfig,
  requestPayload,
  verifyListen,
  verifyStart,
} from "./protocol";
import {
  laohuLoginBySms,
  laohuSendSms,
  newWanmeiState,
  refreshWanmeiCapTicket,
  wanmeiLoginBySms,
  wanmeiSendSms,
} from "./sdk";
import { NOT_FOUND_HTML, renderLoginPage } from "./template";
import type {
  Config,
  Env,
  JsonRecord,
  LoginSession,
  WanmeiRole,
  WanmeiSmsPayload,
} from "./types";

const SESSION_STORAGE_KEY = "session";
const MOBILE_RE = /^1\d{10}$/;
const CODE_RE = /^\d{4,8}$/;

class DurableSessionStore {
  private cached: LoginSession | null | undefined;

  constructor(private readonly storage: DurableObjectStorage) {}

  private async load(): Promise<LoginSession | null> {
    if (this.cached !== undefined) return this.cached;
    const stored =
      (await this.storage.get<LoginSession>(SESSION_STORAGE_KEY)) ?? null;
    this.cached = stored;
    return stored;
  }

  async get(auth: string): Promise<LoginSession | null> {
    const session = await this.load();
    if (session === null || session.auth !== auth) return null;
    if (session.expires_at <= Date.now()) {
      await this.drop();
      return null;
    }
    return session;
  }

  async put(session: LoginSession): Promise<void> {
    this.cached = session;
    await this.storage.put(SESSION_STORAGE_KEY, session);
    await this.storage.setAlarm(session.expires_at);
  }

  async drop(): Promise<void> {
    this.cached = null;
    await Promise.all([
      this.storage.delete(SESSION_STORAGE_KEY),
      this.storage.deleteAlarm(),
    ]);
  }

  async expireFromAlarm(): Promise<void> {
    const session = await this.load();
    if (session === null) return;
    if (session.expires_at <= Date.now()) {
      await this.drop();
      return;
    }
    await this.storage.setAlarm(session.expires_at);
  }
}

export class LoginSessionDurableObject {
  private readonly config: Config;
  private readonly sessions: DurableSessionStore;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: Env) {
    this.config = readConfig(env);
    this.sessions = new DurableSessionStore(state.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "GET") {
      const loginMatch = path.match(/^\/nte\/i\/([^/]+)$/);
      if (loginMatch?.[1] !== undefined) {
        return this.withExclusiveOperation(() =>
          this.handleLoginPage(decodeURIComponent(loginMatch[1]!)),
        );
      }
      const statusMatch = path.match(/^\/nte\/status\/([^/]+)$/);
      if (statusMatch?.[1] !== undefined) {
        return this.withExclusiveOperation(() =>
          this.handleStatus(
            decodeURIComponent(statusMatch[1]!),
            url.searchParams,
          ),
        );
      }
      return new Response("Not Found", { status: 404 });
    }

    if (method !== "POST") return new Response("Not Found", { status: 404 });
    return this.withExclusiveOperation(async () => {
      if (path === "/nte/start") return this.handleStart(request);
      if (path === "/nte/sendSmsCode") return this.handleSendSms(request);
      if (path === "/nte/login") return this.handleLogin(request);
      if (path === "/nte/wanmei/prepare")
        return this.handleWanmeiPrepare(request);
      if (path === "/nte/wanmei/sendSmsCode")
        return this.handleWanmeiSendSms(request);
      if (path === "/nte/wanmei/login") return this.handleWanmeiLogin(request);
      if (path === "/nte/wanmei/selectRole")
        return this.handleWanmeiSelectRole(request);
      return new Response("Not Found", { status: 404 });
    });
  }

  async alarm(): Promise<void> {
    await this.withExclusiveOperation(() => this.sessions.expireFromAlarm());
  }

  private async withExclusiveOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.operationTail;
    let release = (): void => {};
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async handleStart(request: Request): Promise<Response> {
    const payload = await requestPayload(request);
    if (payload === null || !isStartPayload(payload)) {
      return jsonResponse({ detail: "bad_request" }, 400);
    }
    if (!(await verifyStart(payload, this.config))) {
      return jsonResponse({ detail: "bad_signature" }, 401);
    }

    const existing = await this.sessions.get(payload.auth);
    if (existing !== null) {
      return jsonResponse({
        auth: payload.auth,
        expires_in_s: this.config.sessionTtlS,
      });
    }

    const session: LoginSession = {
      auth: payload.auth,
      user_id: payload.user_id,
      bot_id: payload.bot_id ?? "",
      group_id: payload.group_id ?? null,
      device: newDevice(),
      status: "pending",
      msg: "",
      credential: null,
      wanmei: null,
      tajiduo_sms_sent_at: null,
      wanmei_sms_sent_at: null,
      expires_at: Date.now() + this.config.sessionTtlS * 1000,
    };
    await this.sessions.put(session);
    return jsonResponse({
      auth: payload.auth,
      expires_in_s: this.config.sessionTtlS,
    });
  }

  private async handleSendSms(request: Request): Promise<Response> {
    const payload = await requestPayload(request);
    if (
      payload === null ||
      typeof payload.auth !== "string" ||
      typeof payload.mobile !== "string"
    ) {
      return jsonResponse({ detail: "bad_request" }, 400);
    }
    if (!MOBILE_RE.test(payload.mobile)) {
      return jsonResponse({ ok: false, msg: "手机号格式错误" }, 400);
    }
    const session = await this.sessions.get(payload.auth);
    if (session === null)
      return jsonResponse({ detail: "session_expired" }, 404);

    const remaining = cooldownRemainingS(
      session.tajiduo_sms_sent_at,
      this.config.smsCooldownS,
    );
    if (remaining > 0) {
      return jsonResponse(
        { ok: false, msg: `请 ${remaining} 秒后再获取验证码` },
        429,
      );
    }
    session.tajiduo_sms_sent_at = Date.now();
    await this.sessions.put(session);
    try {
      await laohuSendSms(payload.mobile, this.config, session.device);
    } catch {
      return jsonResponse(
        { ok: false, msg: "验证码发送失败，请稍后再试" },
        400,
      );
    }
    return jsonResponse({ ok: true, msg: "验证码已发送" });
  }

  private async handleLogin(request: Request): Promise<Response> {
    const payload = await requestPayload(request);
    if (
      payload === null ||
      typeof payload.auth !== "string" ||
      typeof payload.mobile !== "string" ||
      typeof payload.code !== "string"
    ) {
      return jsonResponse({ detail: "bad_request" }, 400);
    }
    if (!MOBILE_RE.test(payload.mobile)) {
      return jsonResponse({ ok: false, msg: "手机号格式错误" }, 400);
    }
    if (!CODE_RE.test(payload.code)) {
      return jsonResponse({ ok: false, msg: "验证码格式错误" }, 400);
    }
    const session = await this.sessions.get(payload.auth);
    if (session === null)
      return jsonResponse({ detail: "session_expired" }, 404);
    if (session.status === "success") {
      return jsonResponse({ detail: "already_finished" }, 409);
    }

    try {
      const account = await laohuLoginBySms(
        payload.mobile,
        payload.code,
        this.config,
        session.device,
      );
      session.status = "success";
      session.msg = "登录成功";
      session.credential = {
        kind: "tajiduo",
        laohu_token: account.token,
        laohu_user_id: String(account.userId),
      };
      await this.sessions.put(session);
      return jsonResponse({ ok: true, msg: "登录成功" });
    } catch {
      return jsonResponse(
        { ok: false, msg: "验证码错误或已过期，请重新获取" },
        400,
      );
    }
  }

  private async handleWanmeiPrepare(request: Request): Promise<Response> {
    const payload = await requestPayload(request);
    if (payload === null || typeof payload.auth !== "string") {
      return jsonResponse({ detail: "bad_request" }, 400);
    }
    const session = await this.sessions.get(payload.auth);
    if (session === null) {
      return jsonResponse({ ok: false, message: "完美登录链接已失效" }, 400);
    }

    try {
      session.wanmei ??= await newWanmeiState();
      const capTicket = await refreshWanmeiCapTicket(session.wanmei);
      await this.sessions.put(session);
      return jsonResponse({
        ok: true,
        areaCodes: session.wanmei.area_codes,
        capTicket,
      });
    } catch (error) {
      return jsonResponse({ ok: false, message: errorMessage(error) }, 400);
    }
  }

  private async handleWanmeiSendSms(request: Request): Promise<Response> {
    const payload = await requestPayload(request);
    if (payload === null || !isWanmeiSmsPayload(payload, false)) {
      return jsonResponse({ detail: "bad_request" }, 400);
    }
    const session = await this.sessions.get(payload.auth);
    if (session?.wanmei === null || session === null) {
      return jsonResponse({ ok: false, message: "完美登录链接已失效" }, 400);
    }

    const remaining = cooldownRemainingS(
      session.wanmei_sms_sent_at,
      this.config.smsCooldownS,
    );
    if (remaining > 0) {
      return jsonResponse(
        { ok: false, message: `请 ${remaining} 秒后再获取验证码` },
        429,
      );
    }
    session.wanmei_sms_sent_at = Date.now();
    await this.sessions.put(session);
    try {
      await wanmeiSendSms(session.wanmei, payload);
      await this.sessions.put(session);
      return jsonResponse({ ok: true });
    } catch (error) {
      return jsonResponse({ ok: false, message: errorMessage(error) }, 400);
    }
  }

  private async handleWanmeiLogin(request: Request): Promise<Response> {
    const payload = await requestPayload(request);
    if (payload === null || !isWanmeiSmsPayload(payload, true)) {
      return jsonResponse({ detail: "bad_request" }, 400);
    }
    const session = await this.sessions.get(payload.auth);
    if (session?.wanmei === null || session === null) {
      return jsonResponse({ ok: false, message: "完美登录链接已失效" }, 400);
    }

    try {
      const roles = await wanmeiLoginBySms(session.wanmei, payload);
      if (roles.length === 1) finishWanmeiLogin(session, roles[0]!);
      await this.sessions.put(session);
      return jsonResponse({ ok: true, roles });
    } catch (error) {
      return jsonResponse({ ok: false, message: errorMessage(error) }, 400);
    }
  }

  private async handleWanmeiSelectRole(request: Request): Promise<Response> {
    const payload = await requestPayload(request);
    if (
      payload === null ||
      typeof payload.auth !== "string" ||
      typeof payload.roleId !== "string"
    ) {
      return jsonResponse({ detail: "bad_request" }, 400);
    }
    const session = await this.sessions.get(payload.auth);
    const roles = session?.wanmei?.roles;
    if (session === null || !Array.isArray(roles)) {
      return jsonResponse(
        { ok: false, message: "完美登录角色列表已失效" },
        400,
      );
    }
    const role = roles.find((item) => item.roleId === payload.roleId);
    if (role === undefined) {
      return jsonResponse(
        { ok: false, message: "所选角色不在本次登录结果中" },
        400,
      );
    }
    try {
      finishWanmeiLogin(session, role);
      await this.sessions.put(session);
      return jsonResponse({ ok: true });
    } catch (error) {
      return jsonResponse({ ok: false, message: errorMessage(error) }, 400);
    }
  }

  private async handleStatus(
    auth: string,
    parameters: URLSearchParams,
  ): Promise<Response> {
    const timestamp = Number.parseInt(parameters.get("ts") ?? "0", 10);
    const signature = parameters.get("sig") ?? "";
    if (!(await verifyListen(auth, timestamp, signature, this.config))) {
      return jsonResponse({ detail: "bad_signature" }, 401);
    }

    const session = await this.sessions.get(auth);
    if (session === null) {
      return jsonResponse({ status: "expired", msg: "", credential: null });
    }
    const snapshot = {
      status: session.status,
      msg: session.msg,
      credential: session.credential,
    };
    if (snapshot.status === "success" || snapshot.status === "failed") {
      await this.sessions.drop();
    }
    return jsonResponse(snapshot);
  }

  private async handleLoginPage(auth: string): Promise<Response> {
    const session = await this.sessions.get(auth);
    if (session === null) return htmlResponse(NOT_FOUND_HTML, 404);
    return htmlResponse(
      renderLoginPage(
        auth,
        session.user_id,
        this.config.sessionTtlS,
        session.status === "success",
      ),
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "完美世界登录失败";
}

function isWanmeiSmsPayload(
  payload: JsonRecord,
  requireSmsCode: false,
): payload is WanmeiSmsPayload;
function isWanmeiSmsPayload(
  payload: JsonRecord,
  requireSmsCode: true,
): payload is WanmeiSmsPayload & { smsCode: string };
function isWanmeiSmsPayload(
  payload: JsonRecord,
  requireSmsCode: boolean,
): payload is WanmeiSmsPayload {
  return (
    typeof payload.auth === "string" &&
    Number.isInteger(payload.areaCodeId) &&
    typeof payload.phone === "string" &&
    payload.phone !== "" &&
    typeof payload.capTicket === "string" &&
    payload.capTicket !== "" &&
    typeof payload.secCode === "string" &&
    payload.secCode !== "" &&
    (!requireSmsCode ||
      (typeof payload.smsCode === "string" && payload.smsCode !== ""))
  );
}

function finishWanmeiLogin(session: LoginSession, role: WanmeiRole): void {
  const logon = session.wanmei?.logon;
  if (logon === undefined || logon === null || logon === "") {
    throw new Error("完美世界登录凭据已失效");
  }
  session.status = "success";
  session.msg = "登录成功";
  session.credential = {
    kind: "wanmei",
    logon,
    role_id: role.roleId,
    role_name: role.roleName,
  };
  session.wanmei = null;
}
