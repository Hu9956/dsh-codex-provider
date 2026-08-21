// dsh-codex-provider — client 侧插件（浏览器 bundle，ModuleLoader 格式）
// 在设置中注册"供应商"分区：OpenAI Codex 登录状态、设备码 OAuth 登录、导入、退出。
window.__ModuleLoader__.load({
  id: "dsh-codex-provider",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const NS = "settings.codexProvider";
    const CODEX_RPC_CHANNEL = "/codex-provider";
    const CODEX_RPC_METHODS = ["status", "loginStart", "loginStatus", "loginCancel", "importExisting", "logout"];

    function validateCodexResult(method, value) {
      if (!value || typeof value !== "object" || typeof value.ok !== "boolean") {
        throw new TypeError(`${method}: invalid RPC result`);
      }
      if (method === "status" && value.ok) {
        if (typeof value.loggedIn !== "boolean" || typeof value.providerConfigured !== "boolean") {
          throw new TypeError("status: invalid provider state");
        }
      }
      if ((method === "loginStart" || method === "loginStatus") && value.ok && typeof value.phase !== "string") {
        throw new TypeError(`${method}: invalid login phase`);
      }
      return value;
    }

    function createCodexApi(connection) {
      return Object.fromEntries(CODEX_RPC_METHODS.map((method) => [
        method,
        async () => {
          const response = await connection.rpc.call(CODEX_RPC_CHANNEL, method, {});
          if (response?.ok) validateCodexResult(method, response.value);
          return response;
        },
      ]));
    }

    const zh = {
      nav: "供应商",
      title: "OpenAI Codex",
      subtitle: "ChatGPT Plus / Pro 订阅 · Codex 模型",
      loggedIn: "已登录",
      loggedOut: "未登录",
      statusLoading: "正在读取状态…",
      statusUnavailable: "状态不可用",
      providerInactive: "供应商未激活",
      providerActive: "供应商已激活",
      account: "账号",
      plan: "套餐",
      expires: "令牌过期",
      source: "来源",
      login: "使用 OpenAI 账号登录",
      loginHint: "点击后将在浏览器中打开 OpenAI 授权页，输入屏幕上显示的代码完成登录。",
      import: "导入本机 Codex CLI 登录态",
      importHint: "直接使用 ~/.codex/auth.json 中已有的登录态（无需重新登录）。",
      logout: "退出登录",
      logoutConfirm: "确定退出 OpenAI Codex 登录？",
      deviceStep: "请在浏览器中打开以下地址，并输入设备代码：",
      open: "打开授权页面",
      copy: "复制",
      copied: "已复制",
      waiting: "等待授权完成…",
      deviceNotice: "🔐 本登录使用设备代码授权，注意事项如下：\n① 登录前：请先在 ChatGPT 网页端 → 设置 → 账户安全与登录 中打开“为 Codex 启用设备代码授权”开关（未开启将无法授权）；\n② 授权：先复制上方设备代码，再点击“使用 OpenAI 账号登录”，按提示填入该设备代码；\n③ 登录成功后：建议返回 ChatGPT 网页端关闭该开关——不影响本次登录，但下次重新登录前需重新开启。",
      complete: "登录成功！Codex 模型已可用。",
      failed: "登录失败",
      cancel: "取消登录",
      refresh: "刷新",
      planPlus: "Plus",
      planPro: "Pro",
      unknownAccount: "未知账号",
      expiresNever: "未知",
      refreshing: "处理中…",
    };
    const en = {
      nav: "Providers",
      title: "OpenAI Codex",
      subtitle: "ChatGPT Plus / Pro subscription · Codex models",
      loggedIn: "Logged in",
      loggedOut: "Not logged in",
      statusLoading: "Loading status…",
      statusUnavailable: "Status unavailable",
      providerInactive: "Provider not activated",
      providerActive: "Provider active",
      account: "Account",
      plan: "Plan",
      expires: "Token expires",
      source: "Source",
      login: "Sign in with OpenAI",
      loginHint: "You will be asked to open the OpenAI authorization page and enter a code.",
      import: "Import Codex CLI login",
      importHint: "Use the existing login in ~/.codex/auth.json (no re-login needed).",
      logout: "Sign out",
      logoutConfirm: "Sign out of OpenAI Codex?",
      deviceStep: "Open the URL below in your browser and enter the device code:",
      open: "Open authorization page",
      copy: "Copy",
      copied: "Copied",
      waiting: "Waiting for authorization…",
      deviceNotice: "This login uses device-code authorization. Notes:\n\u2460 Before signing in: first turn on \u201cEnable device code authorization for Codex\u201d in ChatGPT web \u2192 Settings \u2192 Account security & login (authorization will fail if it\u2019s off);\n\u2461 Authorize: copy the device code above first, then click \u201cSign in with OpenAI\u201d and enter the device code when prompted;\n\u2462 After signing in: it\u2019s recommended to turn the switch off on the ChatGPT web page \u2014 it won\u2019t affect this login, but turn it back on before your next sign-in.",
      complete: "Signed in! Codex models are ready to use.",
      failed: "Sign-in failed",
      cancel: "Cancel sign-in",
      refresh: "Refresh",
      planPlus: "Plus",
      planPro: "Pro",
      unknownAccount: "Unknown account",
      expiresNever: "Unknown",
      refreshing: "Working…",
    };

    const styles = {
      card: {
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        padding: "16px",
        borderRadius: "12px",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-2)",
        fontSize: "13px",
        color: "var(--dsw-alias-label-primary)",
      },
      head: { display: "flex", alignItems: "center", gap: "10px" },
      title: { fontSize: "15px", fontWeight: 600, lineHeight: 1.4 },
      subtitle: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", marginTop: 2 },
      row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
      label: { color: "var(--dsw-alias-label-tertiary)", minWidth: 72 },
      value: { color: "var(--dsw-alias-label-primary)", fontWeight: 500 },
      code: {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "22px",
        fontWeight: 700,
        letterSpacing: 4,
        padding: "8px 14px",
        borderRadius: "8px",
        border: "1px dashed var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-module-platform)",
        display: "inline-block",
      },
      url: {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "12px",
        wordBreak: "break-all",
        color: "var(--dsw-alias-brand-primary)",
      },
      hint: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.6 },
      deviceStepText: { fontSize: "13px", color: "var(--dsw-alias-label-primary)", lineHeight: 1.6 },
      error: { fontSize: "12px", color: "var(--dsw-alias-label-error)", lineHeight: 1.6 },
      success: { fontSize: "13px", color: "var(--dsw-alias-label-success, #22c55e)", fontWeight: 500 },
      actions: { display: "flex", gap: "8px", flexWrap: "wrap" },
      dot: { display: "inline-block", width: 8, height: 8, borderRadius: "50%", marginRight: 6 },
      dotGreen: { background: "#22c55e" },
      dotRed: { background: "var(--dsw-alias-label-error)" },
      dotGray: { background: "var(--dsw-alias-label-tertiary)" },
      notice: {
        fontSize: "12px",
        lineHeight: 1.7,
        color: "var(--dsw-alias-label-secondary)",
        padding: "8px 10px",
        borderRadius: "8px",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-module-platform)",
      },
      noticeLine: { lineHeight: 1.7 },
    };

    function planLabel(t, plan) {
      if (plan === "plus") return t("planPlus");
      if (plan === "pro") return t("planPro");
      return plan || t("unknownAccount");
    }

    function shortAccount(id) {
      if (!id) return null;
      return id.length > 16 ? id.slice(0, 8) + "…" + id.slice(-4) : id;
    }

    function fmtTime(t, ts) {
      if (!ts) return t("expiresNever");
      const d = new Date(ts);
      return d.toLocaleString();
    }

    function remoteValue(response, fallback) {
      if (!response?.ok) throw new Error(response?.error?.message || fallback);
      const value = response.value;
      if (!value?.ok) throw new Error(value?.error || fallback);
      return value;
    }

    // ── 供应商设置分区组件 ────────────────────────────────────────────────
    function CodexProviderSection({ t, api }) {
      const [status, setStatus] = React.useState(null);
      const [statusLoading, setStatusLoading] = React.useState(true);
      const [statusError, setStatusError] = React.useState(null);
      const [login, setLogin] = React.useState({ phase: "idle", deviceInfo: null, error: null });
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const [copied, setCopied] = React.useState(false);

      const refreshStatus = React.useCallback(async () => {
        setStatusLoading(true);
        setStatusError(null);
        try {
          const r = await api.status();
          setStatus(remoteValue(r, "status failed"));
        } catch (e) {
          setStatusError(String((e && e.message) || e));
        } finally {
          setStatusLoading(false);
        }
      }, [api]);

      React.useEffect(() => {
        refreshStatus();
      }, [refreshStatus]);

      // 登录流程轮询
      React.useEffect(() => {
        if (login.phase !== "starting" && login.phase !== "device_code") return;
        let cancelled = false;
        let timer;
        const poll = async () => {
          try {
            const r = await api.loginStatus();
            if (cancelled) return;
            const v = remoteValue(r, "loginStatus failed");
            setLogin({ phase: v.phase, deviceInfo: v.deviceInfo, error: v.error });
            if (v.phase === "complete" || v.phase === "failed") {
              setBusy(false);
              refreshStatus();
              if (v.phase === "complete") setNotice(t("complete"));
              return;
            }
          } catch (e) {
            if (cancelled) return;
            setBusy(false);
            setNotice(String((e && e.message) || e));
            return;
          }
          timer = setTimeout(poll, 2000);
        };
        timer = setTimeout(poll, 2000);
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }, [login.phase, api, refreshStatus, t]);

      const startLogin = async () => {
        setBusy(true);
        setNotice(null);
        try {
          const r = await api.loginStart();
          remoteValue(r, "loginStart failed");
          setLogin({ phase: "starting", deviceInfo: null, error: null });
        } catch (e) {
          setBusy(false);
          setNotice(String((e && e.message) || e));
        }
      };

      const cancelLogin = async () => {
        setBusy(true);
        try {
          remoteValue(await api.loginCancel(), "loginCancel failed");
          setLogin({ phase: "idle", deviceInfo: null, error: null });
          setBusy(false);
          setNotice(null);
        } catch (e) {
          setBusy(false);
          setNotice(String((e && e.message) || e));
        }
      };

      const importExisting = async () => {
        setBusy(true);
        setNotice(null);
        try {
          const r = await api.importExisting();
          remoteValue(r, "import failed");
          setBusy(false);
          setNotice(t("complete"));
          setLogin({ phase: "idle", deviceInfo: null, error: null });
          refreshStatus();
        } catch (e) {
          setBusy(false);
          setNotice(String((e && e.message) || e));
        }
      };

      const doLogout = async () => {
        if (!window.confirm(t("logoutConfirm"))) return;
        setBusy(true);
        try {
          remoteValue(await api.logout(), "logout failed");
          setStatus(null);
          setStatusError(null);
          setBusy(false);
          refreshStatus();
        } catch (e) {
          setBusy(false);
          setNotice(String((e && e.message) || e));
        }
      };

      const copyCode = () => {
        if (login.deviceInfo?.userCode) {
          navigator.clipboard?.writeText(login.deviceInfo.userCode).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }).catch((e) => {
            setNotice(String((e && e.message) || e));
          });
        }
      };

      const statusReady = status !== null;
      const loggedIn = status?.loggedIn === true;
      const inLoginFlow = login.phase === "starting" || login.phase === "device_code";
      const statusLabel = statusReady
        ? (loggedIn ? t("loggedIn") : t("loggedOut"))
        : (statusLoading ? t("statusLoading") : t("statusUnavailable"));

      return React.createElement(
        "div",
        { style: styles.card },
        // 头部
        React.createElement(
          "div",
          { style: styles.head },
          React.createElement("div", null,
            React.createElement("div", { style: styles.title }, t("title")),
            React.createElement("div", { style: styles.subtitle }, t("subtitle"))
          ),
          React.createElement(
            "span",
            null,
            React.createElement("span", {
              style: { ...styles.dot, ...(loggedIn ? styles.dotGreen : statusError ? styles.dotRed : styles.dotGray) },
            }),
            statusLabel
          ),
          statusReady
            ? (status.providerConfigured
                ? React.createElement(primitives.Pill, { tone: "success" }, t("providerActive"))
                : React.createElement(primitives.Pill, { tone: "neutral" }, t("providerInactive")))
            : React.createElement(primitives.Pill, { tone: "neutral" }, statusLabel)
        ),

        // 已登录信息
        loggedIn &&
          React.createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 6 } },
            React.createElement("div", { style: styles.row },
              React.createElement("span", { style: styles.label }, t("account")),
              React.createElement("span", { style: styles.value }, shortAccount(status?.accountId) || t("unknownAccount"))
            ),
            React.createElement("div", { style: styles.row },
              React.createElement("span", { style: styles.label }, t("plan")),
              React.createElement("span", { style: styles.value }, planLabel(t, status?.planType))
            ),
            React.createElement("div", { style: styles.row },
              React.createElement("span", { style: styles.label }, t("expires")),
              React.createElement("span", { style: styles.value }, fmtTime(t, status?.expiresAt))
            )
          ),

        // 设备码流程提示
        inLoginFlow &&
          React.createElement(
            "div",
            null,
            login.phase === "device_code" && login.deviceInfo
              ? React.createElement(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: 8 } },
                  React.createElement("div", { style: styles.deviceStepText }, t("deviceStep")),
                  React.createElement("div", null,
                    React.createElement("a", {
                      href: login.deviceInfo.verificationUri,
                      target: "_blank",
                      rel: "noreferrer",
                      style: styles.url,
                    }, login.deviceInfo.verificationUri)
                  ),
                  React.createElement("div", { style: styles.row },
                    React.createElement("span", { style: styles.code }, login.deviceInfo.userCode),
                    React.createElement(primitives.Button, { onClick: copyCode, size: "sm" },
                      copied ? t("copied") : t("copy"))
                  ),
                  React.createElement("div", { style: styles.hint }, t("waiting")),
                  React.createElement("div", { style: styles.notice },
                    String(t("deviceNotice")).split("\n").map((line, index) =>
                      React.createElement("div", { key: index, style: styles.noticeLine }, line)
                    )
                  )
                )
              : React.createElement("div", { style: styles.hint }, t("refreshing")),
            React.createElement("div", { style: { ...styles.actions, marginTop: 8 } },
              React.createElement(primitives.Button, { onClick: cancelLogin, disabled: busy, variant: "secondary" }, t("cancel"))
            )
          ),

        // 失败提示
        login.phase === "failed" &&
          React.createElement("div", { style: styles.error },
            t("failed") + (login.error ? ": " + login.error : "")
          ),

        // 操作按钮
        !inLoginFlow && statusReady &&
          React.createElement(
            "div",
            { style: styles.actions },
            loggedIn
              ? React.createElement(primitives.Button, { onClick: doLogout, disabled: busy, variant: "danger" }, t("logout"))
              : React.createElement(primitives.Button, { onClick: startLogin, disabled: busy, variant: "primary" },
                  busy ? t("refreshing") : t("login")),
            !loggedIn &&
              React.createElement(primitives.Button, { onClick: importExisting, disabled: busy, variant: "secondary" }, t("import"))
          ),

        // 提示说明
        !inLoginFlow && statusReady &&
          !loggedIn &&
          React.createElement("div", { style: styles.hint }, t("loginHint")),

        statusError &&
          React.createElement("div", { style: styles.error }, statusError),

        !inLoginFlow && !statusReady && !statusLoading &&
          React.createElement("div", { style: styles.actions },
            React.createElement(primitives.Button, { onClick: refreshStatus, disabled: busy, variant: "secondary" }, t("refresh"))
          ),

        // 通知
        notice &&
          React.createElement(
            "div",
            { style: notice === t("complete") ? styles.success : styles.hint },
            notice
          )
      );
    }

    // ── 插件入口 ──────────────────────────────────────────────────────────
    function apply(ctx) {
      const { slots, locale } = ctx;
      const connection = ctx.get("connection");
      ctx.effect(() => locale.register(NS, { zh, en }), "codex-provider-ui: dictionaries");
      const t = locale.bind(NS);
      const injected = () => ({ api: createCodexApi(connection), t });
      slots.inject("settings.section", () => slots.register({
        name: "settings.section",
        id: "codex-provider",
        order: 14,
        label: () => t("nav"),
        locale: NS,
        inject: injected,
      }, CodexProviderSection));
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "connection"];
    return module.exports;
  },
});
