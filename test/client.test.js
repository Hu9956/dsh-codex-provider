import assert from "node:assert/strict";
import test from "node:test";

test("browser plugin registers the Codex section and calls its dedicated RPC channel", async () => {
  let definition;
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
  };
  try {
    await import(`../lib/client.js?test=${Date.now()}`);
    const plugin = definition.factory((id) => {
      if (id === "react") return {};
      if (id === "@deepseek-ai/dsh-client-ui-primitives") return {};
      throw new Error(`unexpected browser dependency: ${id}`);
    });
    assert.deepEqual(plugin.inject, ["slots", "locale", "connection"]);

    const calls = [];
    const connection = {
      rpc: {
        call(...args) {
          calls.push(args);
          return Promise.resolve({ ok: true, value: { ok: true, loggedIn: true, providerConfigured: true } });
        },
      },
    };
    let registered;
    const ctx = {
      effect(factory) { factory(); },
      locale: {
        register() { return () => {}; },
        bind() { return (key) => key; },
      },
      get(name) {
        assert.equal(name, "connection");
        return connection;
      },
      slots: {
        inject(name, callback) {
          assert.equal(name, "settings.section");
          callback();
        },
        register(options, component) {
          registered = { options, component };
          return () => {};
        },
      },
    };
    plugin.apply(ctx);
    assert.equal(registered.options.id, "codex-provider");
    assert.equal(typeof registered.component, "function");
    await registered.options.inject().api.status();
    assert.deepEqual(calls, [["/codex-provider", "status", {}]]);
  } finally {
    delete globalThis.window;
  }
});
