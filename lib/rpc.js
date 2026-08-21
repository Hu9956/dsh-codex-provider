export const CODEX_RPC_CHANNEL = "/codex-provider";

export const CODEX_RPC_METHODS = Object.freeze([
  "status",
  "loginStart",
  "loginStatus",
  "loginCancel",
  "importExisting",
  "logout",
]);

const METHOD_SET = new Set(CODEX_RPC_METHODS);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function claimsCodexRpc(endpoint) {
  return METHOD_SET.has(endpoint);
}

export async function dispatchCodexRpc(receiver, endpoint, payload, signal) {
  try {
    if (!claimsCodexRpc(endpoint)) throw new Error(`unknown Codex RPC method ${JSON.stringify(endpoint)}`);
    if (!isPlainObject(payload) || Reflect.ownKeys(payload).length !== 0) {
      throw new Error("Codex RPC payload must be an empty object");
    }
    if (signal?.aborted) throw signal.reason ?? new Error("Codex RPC request was cancelled");
    const method = Reflect.get(receiver, endpoint);
    if (typeof method !== "function") throw new Error(`Codex RPC method ${JSON.stringify(endpoint)} is unavailable`);
    return { ok: true, value: await Reflect.apply(method, receiver, []) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: signal?.aborted ? "cancelled" : "internal",
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    };
  }
}
