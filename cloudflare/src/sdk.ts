import { isRecord } from "./protocol";
import type {
  Config,
  JsonRecord,
  LaohuDevice,
  WanmeiRole,
  WanmeiSmsPayload,
  WanmeiState,
} from "./types";

const LAOHU_BASE_URL = "https://user.laohu.com";
const LAOHU_SDK_VERSION = "4.273.0";
const LAOHU_USER_AGENT = "okhttp/4.9.0";
const LAOHU_DEFAULT_PACKAGE = "com.pwrd.htassistant";
const LAOHU_DEFAULT_VERSION_CODE = "12";

const WANMEI_ID_BASE_URL = "https://id.wanmei.com";
const WANMEI_KF_BASE_URL = "https://kf.wanmei.com";
const WANMEI_KF_GAME_ID = "191";
const WANMEI_LOGIN_RETURN_URL = `${WANMEI_KF_BASE_URL}/selfItemFlowQuery?gameId=${WANMEI_KF_GAME_ID}`;
const WANMEI_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const UPSTREAM_REQUEST_TIMEOUT_MS = 15_000;

const MD5_K = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
  0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
  0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
  0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
  0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
];

export function md5Hex(input: string | Uint8Array): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const length = bytes.length;
  const blockCount = Math.ceil((length + 9) / 64);
  const padded = new Uint8Array(blockCount * 64);
  padded.set(bytes);
  padded[length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (length << 3) >>> 0, true);
  view.setUint32(
    padded.length - 4,
    Math.floor(length / 0x20000000) >>> 0,
    true,
  );

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(16);
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let wordIndex: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }
      const previousD = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_K[index]! + words[wordIndex]!) >>> 0;
      const shift = MD5_S[index]!;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
      a = previousD;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const output = new Uint8Array(16);
  const outputView = new DataView(output.buffer);
  outputView.setUint32(0, a0, true);
  outputView.setUint32(4, b0, true);
  outputView.setUint32(8, c0, true);
  outputView.setUint32(12, d0, true);
  return Array.from(output, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function aesEcbEncryptBase64(
  keyBytes: Uint8Array,
  plaintext: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(plaintext);
  const paddingLength = 16 - (bytes.length % 16);
  const padded = new Uint8Array(bytes.length + paddingLength);
  padded.set(bytes);
  padded.fill(paddingLength, bytes.length);

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-CBC", length: 128 },
    false,
    ["encrypt"],
  );
  const encrypted = new Uint8Array(padded.length);
  const zeroIv = new Uint8Array(16);
  for (let offset = 0; offset < padded.length; offset += 16) {
    const block = padded.slice(offset, offset + 16);
    // 对单个块使用零 IV 的 CBC 等价于 ECB；WebCrypto 追加的填充块不取用。
    const result = await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: zeroIv },
      key,
      block,
    );
    encrypted.set(new Uint8Array(result).slice(0, 16), offset);
  }
  return bytesToBase64(encrypted);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function rsaOaepEncrypt(
  publicKey: string,
  value: string,
): Promise<string> {
  const encoded = publicKey
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(encoded), (character) =>
    character.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSA-OAEP", hash: "SHA-1" },
    false,
    ["encrypt"],
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    key,
    new TextEncoder().encode(value),
  );
  return bytesToBase64(new Uint8Array(encrypted));
}

type FormValues = Record<string, string | number>;

function laohuCommonFields(
  config: Config,
  device: LaohuDevice,
  useMilliseconds: boolean,
): FormValues {
  const timestamp = useMilliseconds
    ? Date.now()
    : Math.floor(Date.now() / 1000);
  const fields: FormValues = {
    appId: config.laohuAppId,
    channelId: "1",
    deviceId: device.device_id,
    deviceType: device.device_type,
    deviceModel: device.device_model,
    deviceName: device.device_name,
    deviceSys: device.device_sys,
    adm: device.adm,
    idfa: device.idfa,
    sdkVersion: LAOHU_SDK_VERSION,
    bid: LAOHU_DEFAULT_PACKAGE,
    t: timestamp,
  };
  if (useMilliseconds) {
    fields.version = LAOHU_DEFAULT_VERSION_CODE;
    fields.mac = device.mac;
  } else {
    fields.versionCode = LAOHU_DEFAULT_VERSION_CODE;
    fields.imei = device.imei;
  }
  return fields;
}

function laohuSign(parameters: FormValues, appKey: string): string {
  const raw = Object.keys(parameters)
    .sort()
    .map((key) => String(parameters[key]))
    .join("");
  return md5Hex(`${raw}${appKey}`);
}

function formUrlEncode(parameters: FormValues): string {
  return Object.entries(parameters)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join("&");
}

async function laohuSubmit(
  path: string,
  parameters: FormValues,
  config: Config,
  keepEmpty = false,
): Promise<unknown> {
  const signed: FormValues = {
    ...parameters,
    sign: laohuSign(parameters, config.laohuAppKey),
  };
  const cleaned: FormValues = {};
  for (const [key, value] of Object.entries(signed)) {
    if (!keepEmpty && value === "") continue;
    cleaned[key] = value;
  }

  const response = await fetch(`${LAOHU_BASE_URL}${path}`, {
    method: "POST",
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_REQUEST_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": LAOHU_USER_AGENT,
    },
    body: formUrlEncode(cleaned),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`[${path}] HTTP ${response.status}`);
  if (text === "") throw new Error(`[${path}] 响应为空`);

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isRecord(payload)) throw new Error(`[${path}] 响应格式错误`);
  if (payload.code !== 0 && payload.code !== "0") {
    throw new Error(
      `[${path}] ${typeof payload.message === "string" ? payload.message : ""}`,
    );
  }
  return payload.result ?? {};
}

export async function laohuSendSms(
  cellphone: string,
  config: Config,
  device: LaohuDevice,
): Promise<void> {
  const parameters = laohuCommonFields(config, device, false);
  parameters.cellphone = cellphone;
  parameters.areaCodeId = "1";
  parameters.type = "16";
  await laohuSubmit(
    "/m/newApi/sendPhoneCaptchaWithOutLogin",
    parameters,
    config,
  );
}

export async function laohuLoginBySms(
  cellphone: string,
  code: string,
  config: Config,
  device: LaohuDevice,
): Promise<{ userId: number; token: string }> {
  const verification = laohuCommonFields(config, device, false);
  verification.cellphone = cellphone;
  verification.captcha = code;
  await laohuSubmit(
    "/m/newApi/checkPhoneCaptchaWithOutLogin",
    verification,
    config,
  );

  const key = new TextEncoder().encode(config.laohuAppKey.slice(-16));
  const parameters = laohuCommonFields(config, device, true);
  parameters.cellphone = await aesEcbEncryptBase64(key, cellphone);
  parameters.captcha = await aesEcbEncryptBase64(key, code);
  parameters.areaCodeId = "1";
  parameters.type = "16";

  const raw = await laohuSubmit(
    "/openApi/sms/new/login",
    parameters,
    config,
    true,
  );
  if (!isRecord(raw)) throw new Error("老虎登录返回格式错误");
  const token = raw.token == null ? "" : String(raw.token);
  const userId = Number.parseInt(String(raw.userId ?? ""), 10);
  if (token === "") throw new Error("老虎登录返回 token 为空");
  if (!Number.isFinite(userId) || userId <= 0)
    throw new Error("老虎登录返回 userId 无效");
  return { userId, token };
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function setCookieHeaders(headers: Headers): string[] {
  const workersHeaders = headers as Headers & {
    getAll?: (name: string) => string[];
    getSetCookie?: () => string[];
  };
  if (typeof workersHeaders.getAll === "function") {
    return workersHeaders.getAll("Set-Cookie");
  }
  if (typeof workersHeaders.getSetCookie === "function") {
    return workersHeaders.getSetCookie();
  }
  const value = headers.get("Set-Cookie");
  return value === null ? [] : [value];
}

function updateCookies(
  cookies: Record<string, string>,
  headers: Headers,
): void {
  for (const header of setCookieHeaders(headers)) {
    const pair = header.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    cookies[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
}

interface WanmeiRequestOptions {
  method?: "GET" | "POST";
  query?: FormValues;
  form?: FormValues;
  headers?: Record<string, string>;
}

async function wanmeiRequest(
  wanmei: WanmeiState,
  baseUrl: string,
  path: string,
  options: WanmeiRequestOptions = {},
): Promise<Response> {
  const url = new URL(path, baseUrl);
  if (options.query !== undefined) {
    for (const [name, value] of Object.entries(options.query)) {
      url.searchParams.set(name, String(value));
    }
  }
  const headers = new Headers({
    Accept: "*/*",
    "User-Agent": WANMEI_USER_AGENT,
    "X-Requested-With": "XMLHttpRequest",
    ...options.headers,
  });
  const cookies = cookieHeader(wanmei.cookies);
  if (cookies !== "") headers.set("Cookie", cookies);
  if (options.form !== undefined) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  }

  const response = await fetch(url, {
    method: options.method ?? "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_REQUEST_TIMEOUT_MS),
    headers,
    body: options.form === undefined ? undefined : formUrlEncode(options.form),
    redirect: "manual",
  });
  updateCookies(wanmei.cookies, response.headers);
  if (response.status >= 400)
    throw new Error(`[${path}] HTTP ${response.status}`);
  return response;
}

async function wanmeiJsonForm(
  wanmei: WanmeiState,
  path: string,
  form: FormValues,
): Promise<JsonRecord> {
  const response = await wanmeiRequest(wanmei, WANMEI_ID_BASE_URL, path, {
    method: "POST",
    form,
  });
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error(`[${path}] 响应格式错误`);
  if (payload.code !== 0) {
    const message =
      typeof payload.message === "string" && payload.message !== ""
        ? payload.message
        : `[${path}] 请求失败`;
    throw new Error(message);
  }
  return payload;
}

export async function newWanmeiState(): Promise<WanmeiState> {
  const wanmei: WanmeiState = {
    public_key: "",
    jsession_id: "",
    area_codes: [],
    cookies: {},
    roles: null,
    logon: null,
  };
  const loginResponse = await wanmeiRequest(
    wanmei,
    WANMEI_ID_BASE_URL,
    "/login",
    {
      query: { location: WANMEI_LOGIN_RETURN_URL },
      headers: { Accept: "text/html,application/xhtml+xml" },
    },
  );
  const html = await loginResponse.text();
  const publicKey = html.match(/id="publicKey"[^>]*value="([^"]+)"/);
  const jsessionId = html.match(/id="jsessionId"[^>]*value="([^"]+)"/);
  if (publicKey?.[1] === undefined || jsessionId?.[1] === undefined) {
    throw new Error("完美世界登录页格式错误");
  }

  const areaCodesResponse = await wanmeiJsonForm(wanmei, "/areaCode/list", {});
  if (
    !Array.isArray(areaCodesResponse.result) ||
    !areaCodesResponse.result.every(isRecord)
  ) {
    throw new Error("完美世界区号列表格式错误");
  }
  wanmei.public_key = publicKey[1];
  wanmei.jsession_id = jsessionId[1];
  wanmei.area_codes = areaCodesResponse.result;
  return wanmei;
}

export async function refreshWanmeiCapTicket(
  wanmei: WanmeiState,
): Promise<string> {
  const response = await wanmeiJsonForm(wanmei, "/user/security/getCapTicket", {
    t: String(Date.now()),
  });
  if (typeof response.result !== "string") {
    throw new Error("完美世界验证码票据格式错误");
  }
  return response.result;
}

export async function wanmeiSendSms(
  wanmei: WanmeiState,
  payload: WanmeiSmsPayload,
): Promise<void> {
  await wanmeiJsonForm(wanmei, "/checkPhoneWithNationAreaId", {
    nationAreaId: payload.areaCodeId,
    phoneNumber: payload.phone,
  });
  await wanmeiJsonForm(wanmei, "/sendPhoneCaptchaForSlidCaptcha", {
    nationAreaId: payload.areaCodeId,
    phone: payload.phone,
    capTicket: payload.capTicket,
    secCode: payload.secCode,
  });
}

function isWanmeiRole(value: unknown): value is WanmeiRole {
  return (
    isRecord(value) &&
    typeof value.roleId === "string" &&
    typeof value.roleName === "string"
  );
}

export async function wanmeiLoginBySms(
  wanmei: WanmeiState,
  payload: WanmeiSmsPayload & { smsCode: string },
): Promise<WanmeiRole[]> {
  const random = new Uint8Array(8);
  crypto.getRandomValues(random);
  const deviceId = Array.from(random, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  await wanmeiJsonForm(wanmei, "/setDeviceInfo", {
    jsessionId: wanmei.jsession_id,
    deviceId: `NTEUID-${deviceId}`,
    deviceModel: "NTEUID Web Login",
    deviceSys: "Web",
  });
  await wanmeiJsonForm(wanmei, "/checkPhoneCaptcha", {
    phone: payload.phone,
    phoneCaptcha: payload.smsCode,
  });
  await wanmeiJsonForm(wanmei, "/shortMessageLogon", {
    phoneNumber: await rsaOaepEncrypt(wanmei.public_key, payload.phone),
    newCaptcha: await rsaOaepEncrypt(wanmei.public_key, payload.smsCode),
    nationAreaId: payload.areaCodeId,
    capTicket: payload.capTicket,
    secCode: payload.secCode,
    location: WANMEI_LOGIN_RETURN_URL,
    state: wanmei.jsession_id,
  });
  const logon = wanmei.cookies.logon;
  if (logon === undefined || logon === "") {
    throw new Error("完美世界短信登录响应缺少 logon Cookie");
  }

  const response = await wanmeiRequest(
    wanmei,
    WANMEI_KF_BASE_URL,
    "/laohuSelfService/searchActiveGameRoles",
    {
      query: { gameId: WANMEI_KF_GAME_ID },
      headers: { Referer: WANMEI_LOGIN_RETURN_URL },
    },
  );
  const roles: unknown = await response.json();
  if (
    !Array.isArray(roles) ||
    roles.length === 0 ||
    !roles.every(isWanmeiRole)
  ) {
    throw new Error("完美世界客服未返回有效的异环角色");
  }
  wanmei.roles = roles;
  wanmei.logon = logon;
  return roles;
}
