export interface Env {
  LOGIN_SESSIONS: DurableObjectNamespace;
  SHARED_SECRET?: string;
  SESSION_TTL_S?: string;
  SIG_TTL_S?: string;
  SMS_COOLDOWN_S?: string;
}

export interface Config {
  sharedSecret: string;
  sessionTtlS: number;
  sigTtlS: number;
  smsCooldownS: number;
  laohuAppId: string;
  laohuAppKey: string;
}

export type JsonRecord = Record<string, unknown>;

export interface LaohuDevice {
  device_id: string;
  device_type: string;
  device_model: string;
  device_name: string;
  device_sys: string;
  adm: string;
  imei: string;
  idfa: string;
  mac: string;
}

export interface TajiduoCredential {
  kind: "tajiduo";
  laohu_token: string;
  laohu_user_id: string;
}

export interface WanmeiCredential {
  kind: "wanmei";
  logon: string;
  role_id: string;
  role_name: string;
}

export type Credential = TajiduoCredential | WanmeiCredential;
export type LoginStatus = "pending" | "success" | "failed";

export interface WanmeiRole extends JsonRecord {
  roleId: string;
  roleName: string;
}

export interface WanmeiState {
  public_key: string;
  jsession_id: string;
  area_codes: JsonRecord[];
  cookies: Record<string, string>;
  roles: WanmeiRole[] | null;
  logon: string | null;
}

export interface LoginSession {
  auth: string;
  user_id: string;
  bot_id: string;
  group_id: string | null;
  device: LaohuDevice;
  status: LoginStatus;
  msg: string;
  credential: Credential | null;
  wanmei: WanmeiState | null;
  tajiduo_sms_sent_at: number | null;
  wanmei_sms_sent_at: number | null;
  expires_at: number;
}

export interface StartPayload extends JsonRecord {
  auth: string;
  user_id: string;
  bot_id?: string;
  group_id?: string | null;
  ts: number;
  sig?: string;
}

export interface WanmeiSmsPayload extends JsonRecord {
  auth: string;
  areaCodeId: number;
  phone: string;
  capTicket: string;
  secCode: string;
  smsCode?: string;
}
