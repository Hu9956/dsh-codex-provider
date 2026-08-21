// dsh-codex-provider — host 侧插件
// OpenAI Codex (ChatGPT Plus/Pro) 供应商管理：
//   - 设备码 OAuth 登录（复用 ChatGPT 订阅额度）
//   - 从本机 ~/.codex/auth.json 导入已有 Codex CLI 登录态
//   - access token 自动刷新（refresh_token 轮换）
//   - 将 openai-codex 路由激活进 llm-pi-ai（apiKeyEnv 凭证引用）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { CODEX_RPC_CHANNEL, dispatchCodexRpc } from "./rpc.js";

const name = "codex-provider";
const inject = ["credentials", "settings", "connection"];

// ── OpenAI Codex 设备码 OAuth 常量（与官方 Codex CLI / pi-ai 一致）──
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const REFRESH_SKEW_MS = 10 * 60 * 1000; // access token 剩余不足 10 分钟即刷新
const REQUEST_TIMEOUT_MS = 30 * 1000;
const REFRESH_LOCK_WAIT_MS = 45 * 1000;
const REFRESH_LOCK_STALE_MS = 2 * 60 * 1000;

const KEY_REF = "OPENAI_CODEX_API_KEY";
const REFRESH_REF = "OPENAI_CODEX_REFRESH_TOKEN";
const SETTINGS_NS = "llm-pi-ai";
const SETTINGS_PATH = ["providers", "openai-codex", "apiKeyEnv"];

function codexAuthFile() {
  return path.join(os.homedir(), ".codex", "auth.json");
}

function refreshLockFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, ".codex-provider-refresh.lock");
}

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("操作已取消"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("操作已取消"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function acquireRefreshLock(signal) {
  const filename = refreshLockFile();
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  await fs.promises.mkdir(path.dirname(filename), { recursive: true });
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error("刷新已取消");
    const owner = JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce: Math.random().toString(36).slice(2) });
    let handle;
    try {
      handle = await fs.promises.open(filename, "wx", 0o600);
      try {
        await handle.writeFile(owner, "utf8");
      } catch (error) {
        await handle.close().catch(() => {});
        await fs.promises.unlink(filename).catch(() => {});
        throw error;
      }
      return async () => {
        await handle.close().catch(() => {});
        try {
          const current = await fs.promises.readFile(filename, "utf8");
          if (current === owner) await fs.promises.unlink(filename);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    try {
      const stat = await fs.promises.stat(filename);
      if (Date.now() - stat.mtimeMs > REFRESH_LOCK_STALE_MS) {
        const stale = `${filename}.stale-${process.pid}-${Date.now()}`;
        try {
          await fs.promises.rename(filename, stale);
          await fs.promises.unlink(stale).catch(() => {});
          continue;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    await delay(250, signal);
  }
  throw new Error("等待令牌刷新锁超时");
}

// ── JWT 工具 ────────────────────────────────────────────────────────────────
function decodeJwt(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  const auth = payload?.["https://api.openai.com/auth"];
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : null;
}

function extractPlanType(accessToken) {
  const payload = decodeJwt(accessToken);
  const auth = payload?.["https://api.openai.com/auth"];
  return typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null;
}

function extractExpiresAt(accessToken) {
  const payload = decodeJwt(accessToken);
  return typeof payload?.exp === "number" ? payload.exp * 1000 : null;
}

function maskAccountId(accountId) {
  if (typeof accountId !== "string") return null;
  return accountId.length > 16 ? `${accountId.slice(0, 8)}…${accountId.slice(-4)}` : accountId;
}

function friendlyError(e) {
  return e instanceof Error ? e.message : String(e);
}

// ── 设备码 OAuth 流程（自实现，逻辑与 pi-ai/Codex CLI 一致）───────────────
async function startDeviceAuth(signal) {
  const response = await fetch(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: requestSignal(signal),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`设备码请求失败 (${response.status}): ${text.slice(0, 200)}`);
  }
  const json = await response.json();
  // OpenAI 可能返回字符串形式的 interval（如 "5"），需归一化为数字。
  const intervalSeconds = typeof json?.interval === "string" ? Number(json.interval.trim()) : json?.interval;
  if (!json?.device_auth_id || !json.user_code || typeof intervalSeconds !== "number" || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new Error(`设备码响应格式无效: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalSeconds,
  };
}

async function pollDeviceAuth(device, signal) {
  const expiresAt = Date.now() + DEVICE_CODE_TIMEOUT_SECONDS * 1000;
  while (Date.now() < expiresAt) {
    if (signal?.aborted) throw new Error("登录已取消");
    const response = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
      signal: requestSignal(signal),
    });
    if (response.ok) {
      const json = await response.json();
      if (json?.authorization_code && json.code_verifier) {
        return { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier };
      }
      throw new Error("设备码授权响应格式无效");
    }
    const text = await response.text().catch(() => "");
    let errorCode;
    try {
      const json = JSON.parse(text);
      errorCode = typeof json?.error === "object" ? json.error?.code : json?.error;
    } catch {
      /* ignore */
    }
    if (errorCode !== "deviceauth_authorization_pending" && response.status !== 403 && response.status !== 404) {
      throw new Error(`设备码授权失败 (${response.status}): ${text.slice(0, 200)}`);
    }
    await delay(Math.max(device.intervalSeconds ?? 5, 2) * 1000, signal);
  }
  throw new Error("设备码已过期，请重新登录");
}

async function exchangeAuthorizationCode(code, verifier, signal) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: DEVICE_REDIRECT_URI,
    }),
    signal: requestSignal(signal),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`换取令牌失败 (${response.status}): ${text.slice(0, 200)}`);
  }
  const json = await response.json();
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("令牌响应缺少必要字段");
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: extractAccountId(json.access_token),
  };
}

async function refreshAccessToken(refreshToken, signal) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: requestSignal(signal),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`令牌刷新失败 (${response.status}): ${text.slice(0, 200)}`);
  }
  const json = await response.json();
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("刷新响应缺少必要字段");
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: extractAccountId(json.access_token),
  };
}

// ── Codex 供应商 Gateway（独立 Connection RPC 通道，供浏览器 client 调用）──
class CodexGateway extends Service {
  constructor(ctx) {
    super(ctx, "codexProvider");
    this.ctx = ctx;
    this.loginPhase = "idle"; // idle | starting | device_code | complete | failed
    this.loginError = null;
    this.deviceInfo = null;
    this.abortController = null;
    this.loginTask = null;
    this.refreshTask = null;
    this.refreshAbortController = null;
    this.lastCredential = null;
    ctx.effect(() => ctx.connection.rpc.handle(
      CODEX_RPC_CHANNEL,
      (endpoint, payload, signal) => dispatchCodexRpc(this, endpoint, payload, signal),
      { authority: "trusted-host" },
    ), "codex-provider: Connection RPC channel");

    // Keep refresh work inside the Service lifecycle so the loader owns both
    // registration and cleanup of the remote gateway.
    this.maybeRefresh().catch(() => {});
    const timer = setInterval(() => {
      this.maybeRefresh().catch(() => {});
    }, 60_000);
    ctx.effect(() => async () => {
      clearInterval(timer);
      this.abortController?.abort();
      this.refreshAbortController?.abort();
      await Promise.allSettled([this.loginTask, this.refreshTask].filter(Boolean));
    }, "codex-provider: background task cleanup");
  }

  // status: 登录与供应商配置状态
  async status() {
    const key = await this.ctx.credentials.resolve(KEY_REF);
    const refresh = await this.ctx.credentials.resolve(REFRESH_REF);
    let providerConfigured = false;
    try {
      const section = await this.ctx.settings.get(SETTINGS_NS);
      providerConfigured = section?.providers?.["openai-codex"]?.apiKeyEnv === KEY_REF;
    } catch {
      /* settings 不可用时按未配置处理 */
    }
    const access = key?.value ?? null;
    return {
      ok: true,
      loggedIn: Boolean(access),
      hasRefresh: Boolean(refresh?.value),
      providerConfigured,
      accountId: maskAccountId(this.lastCredential?.accountId ?? (access ? extractAccountId(access) : null)),
      planType: access ? extractPlanType(access) : null,
      expiresAt: this.lastCredential?.expires ?? (access ? extractExpiresAt(access) : null),
      source: this.lastCredential?.source ?? (access ? "credential" : null),
      login: {
        phase: this.loginPhase,
        error: this.loginError,
        deviceInfo: this.deviceInfo,
      },
    };
  }

  // loginStart: 启动设备码 OAuth 流程（后台运行）
  async loginStart() {
    if (this.loginPhase === "starting" || this.loginPhase === "device_code") {
      return { ok: true, phase: this.loginPhase };
    }
    this.abortController = new AbortController();
    this.loginPhase = "starting";
    this.loginError = null;
    this.deviceInfo = null;
    const signal = this.abortController.signal;
    const controller = this.abortController;
    const run = async () => {
      try {
        const device = await startDeviceAuth(signal);
        this.deviceInfo = {
          userCode: device.userCode,
          verificationUri: DEVICE_VERIFICATION_URI,
          intervalSeconds: device.intervalSeconds,
          expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
        };
        this.loginPhase = "device_code";
        const { authorizationCode, codeVerifier } = await pollDeviceAuth(device, signal);
        const credential = await exchangeAuthorizationCode(authorizationCode, codeVerifier, signal);
        await this.storeCredential(credential, "oauth", signal);
        this.loginPhase = "complete";
      } catch (error) {
        if (signal.aborted && this.abortController === controller) {
          this.loginPhase = "idle";
        } else if (this.abortController === controller) {
          this.loginPhase = "failed";
          this.loginError = friendlyError(error);
        }
      } finally {
        if (this.abortController === controller) this.abortController = null;
      }
    };
    const task = run().catch((error) => {
      this.ctx.logger.warn("codex-provider: login task error: %s", friendlyError(error));
    }).finally(() => {
      if (this.loginTask === task) this.loginTask = null;
    });
    this.loginTask = task;
    return { ok: true, phase: "starting" };
  }

  // loginStatus: 查询登录流程当前状态（client 轮询用）
  async loginStatus() {
    return {
      ok: true,
      phase: this.loginPhase,
      error: this.loginError,
      deviceInfo: this.deviceInfo,
    };
  }

  // loginCancel: 中止进行中的登录流程
  async loginCancel() {
    this.abortController?.abort();
    this.abortController = null;
    await this.loginTask?.catch(() => {});
    this.loginPhase = "idle";
    this.loginError = null;
    this.deviceInfo = null;
    return { ok: true };
  }

  // importExisting: 导入本机 Codex CLI 已登录态（~/.codex/auth.json）
  async importExisting() {
    let raw;
    try {
      raw = fs.readFileSync(codexAuthFile(), "utf8");
    } catch {
      return { ok: false, error: "未找到 ~/.codex/auth.json（请先在本机用 Codex CLI 登录）" };
    }
    try {
      const auth = JSON.parse(raw);
      const tokens = auth?.tokens;
      if (!tokens?.access_token) return { ok: false, error: "~/.codex/auth.json 缺少 access_token" };
      if (!tokens?.refresh_token) return { ok: false, error: "~/.codex/auth.json 缺少 refresh_token" };
      const credential = {
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: extractExpiresAt(tokens.access_token) ?? Date.now() + 30 * 60 * 1000,
        accountId: extractAccountId(tokens.access_token) ?? tokens.account_id ?? null,
      };
      await this.storeCredential(credential, "codex-cli");
      return { ok: true, accountId: maskAccountId(credential.accountId), planType: extractPlanType(credential.access) };
    } catch (error) {
      return { ok: false, error: friendlyError(error) };
    }
  }

  // logout: 清除凭证与供应商配置引用
  async logout() {
    this.abortController?.abort();
    this.refreshAbortController?.abort();
    await Promise.allSettled([this.loginTask, this.refreshTask].filter(Boolean));
    const controller = new AbortController();
    const release = await acquireRefreshLock(controller.signal);
    try {
      const results = await Promise.allSettled([
        this.ctx.credentials.unset(KEY_REF),
        this.ctx.credentials.unset(REFRESH_REF),
        this.ctx.settings.mutate(SETTINGS_NS, [{ op: "unset", path: SETTINGS_PATH }]),
      ]);
      this.lastCredential = null;
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        throw new Error(`退出登录未完全成功: ${failures.map((result) => friendlyError(result.reason)).join("; ")}`);
      }
    } finally {
      await release();
    }
    return { ok: true };
  }

  // 写凭证 + 激活 openai-codex 路由（幂等）
  async storeCredential(credential, source, signal) {
    if (!credential?.access || !credential?.refresh) throw new Error("凭证不完整");
    this.refreshAbortController?.abort();
    await this.refreshTask?.catch(() => {});
    const release = await acquireRefreshLock(signal);
    try {
      await this.ctx.credentials.set(REFRESH_REF, credential.refresh);
      await this.ctx.credentials.set(KEY_REF, credential.access);
      await this.ctx.settings.mutate(SETTINGS_NS, [{ op: "set", path: SETTINGS_PATH, value: KEY_REF }]);
      this.lastCredential = {
        expires: credential.expires,
        accountId: credential.accountId,
        source,
      };
    } finally {
      await release();
    }
  }

  // 按需刷新 access token（refresh_token 轮换）
  async maybeRefresh() {
    if (this.refreshTask) return this.refreshTask;
    const task = this.refreshOnce().finally(() => {
      if (this.refreshTask === task) this.refreshTask = null;
    });
    this.refreshTask = task;
    return task;
  }

  async refreshOnce() {
    let refresh = await this.ctx.credentials.resolve(REFRESH_REF);
    if (!refresh?.value) return;
    let access = await this.ctx.credentials.resolve(KEY_REF);
    let expiresAt = access?.value ? extractExpiresAt(access.value) : null;
    if (expiresAt !== null && expiresAt - Date.now() > REFRESH_SKEW_MS) return;

    const controller = new AbortController();
    this.refreshAbortController = controller;
    let release;
    try {
      release = await acquireRefreshLock(controller.signal);
      // Another Harness process may have refreshed while this process waited.
      access = await this.ctx.credentials.resolve(KEY_REF);
      expiresAt = access?.value ? extractExpiresAt(access.value) : null;
      if (expiresAt !== null && expiresAt - Date.now() > REFRESH_SKEW_MS) return;
      refresh = await this.ctx.credentials.resolve(REFRESH_REF);
      if (!refresh?.value) return;
      const credential = await refreshAccessToken(refresh.value, controller.signal);
      // Store the rotated refresh token first. If the second write fails, a
      // later attempt can still recover instead of retaining an invalid token.
      await this.ctx.credentials.set(REFRESH_REF, credential.refresh);
      await this.ctx.credentials.set(KEY_REF, credential.access);
      this.lastCredential = {
        expires: credential.expires,
        accountId: credential.accountId,
        source: this.lastCredential?.source ?? "oauth",
      };
      this.ctx.logger.info("codex-provider: access token refreshed");
    } catch (error) {
      if (!controller.signal.aborted) {
        this.ctx.logger.warn("codex-provider: token refresh failed: %s", friendlyError(error));
      }
    } finally {
      await release?.().catch((error) => {
        this.ctx.logger.warn("codex-provider: refresh lock cleanup failed: %s", friendlyError(error));
      });
      if (this.refreshAbortController === controller) this.refreshAbortController = null;
    }
  }
}

CodexGateway.inject = inject;

export { CodexGateway, CodexGateway as default, inject, name };
