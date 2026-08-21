import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_RPC_CHANNEL,
  CODEX_RPC_METHODS,
  claimsCodexRpc,
  dispatchCodexRpc,
} from "../lib/rpc.js";

test("Codex RPC owns a dedicated channel and the six supported methods", () => {
  assert.equal(CODEX_RPC_CHANNEL, "/codex-provider");
  assert.deepEqual(CODEX_RPC_METHODS, [
    "status",
    "loginStart",
    "loginStatus",
    "loginCancel",
    "importExisting",
    "logout",
  ]);
  for (const method of CODEX_RPC_METHODS) assert.equal(claimsCodexRpc(method), true);
  assert.equal(claimsCodexRpc("unknown"), false);
});

test("Codex RPC dispatches an empty request and preserves the business result", async () => {
  const receiver = {
    async status() {
      return { ok: true, loggedIn: true, providerConfigured: true };
    },
  };
  assert.deepEqual(await dispatchCodexRpc(receiver, "status", {}, new AbortController().signal), {
    ok: true,
    value: { ok: true, loggedIn: true, providerConfigured: true },
  });
});

test("Codex RPC rejects unknown methods, unexpected payloads, and cancelled calls", async () => {
  const receiver = { async status() { return { ok: true }; } };
  const signal = new AbortController().signal;
  assert.equal((await dispatchCodexRpc(receiver, "missing", {}, signal)).error.code, "internal");
  assert.equal((await dispatchCodexRpc(receiver, "status", { unexpected: true }, signal)).error.code, "internal");
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  assert.equal((await dispatchCodexRpc(receiver, "status", {}, controller.signal)).error.code, "cancelled");
});
