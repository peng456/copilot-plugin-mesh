import { createCanvas, joinSession, CanvasError } from "@github/copilot-sdk/extension";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const STORAGE_DIR = resolve(process.cwd(), ".copilot", "plugin-mesh");
const STORAGE_FILE = resolve(STORAGE_DIR, "registry.json");

const BUILTIN_PLUGINS = {
  echo: {
    name: "echo",
    kind: "builtin",
    description: "Return the incoming payload unchanged.",
    invoke: async (value) => ({ received: value }),
  },
  time: {
    name: "time",
    kind: "builtin",
    description: "Return the current UTC timestamp.",
    invoke: async () => ({ now: new Date().toISOString() }),
  },
  uppercase: {
    name: "uppercase",
    kind: "builtin",
    description: "Convert a string payload to uppercase.",
    invoke: async (value) => ({ result: String(value ?? "").toUpperCase() }),
  },
  ping: {
    name: "ping",
    kind: "builtin",
    description: "Return a simple health-check response.",
    invoke: async (value) => ({ ok: true, value, message: "pong" }),
  },
};

const registry = new Map(Object.entries(BUILTIN_PLUGINS));
const servers = new Map();

function ensureStorage() {
  mkdirSync(dirname(STORAGE_FILE), { recursive: true });
  if (!existsSync(STORAGE_FILE)) {
    const snapshot = {
      plugins: Object.values(BUILTIN_PLUGINS).map(({ name, kind, description }) => ({
        name,
        kind,
        description,
      })),
    };
    writeFileSync(STORAGE_FILE, JSON.stringify(snapshot, null, 2));
  }
}

function persistRegistry() {
  ensureStorage();
  const snapshot = {
    plugins: [...registry.values()].map(({ name, kind, description }) => ({
      name,
      kind,
      description,
    })),
  };
  writeFileSync(STORAGE_FILE, JSON.stringify(snapshot, null, 2));
}

function normalizeChain(values) {
  if (Array.isArray(values)) return values;
  if (typeof values === "string") return [values];
  return [];
}

function runStrategy(strategy, payload) {
  switch (strategy) {
    case "uppercase":
      return { result: String(payload ?? "").toUpperCase() };
    case "lowercase":
      return { result: String(payload ?? "").toLowerCase() };
    case "reverse":
      return { result: String(payload ?? "").split("").reverse().join("") };
    case "json":
      return { result: payload };
    default:
      return { value: payload };
  }
}

function listCurrentPlugins() {
  return [...registry.values()].map(({ name, kind, description }) => ({
    name,
    kind,
    description,
  }));
}

async function invokePluginChain(names, input) {
  const chain = normalizeChain(names);
  if (chain.length === 0) {
    throw new CanvasError("plugin_chain_empty", "Provide at least one plugin name to run.");
  }

  let current = input;
  const trace = [];

  for (const pluginName of chain) {
    const plugin = registry.get(pluginName);
    if (!plugin) {
      throw new CanvasError("plugin_not_found", `Unknown plugin: ${pluginName}`);
    }
    current = await plugin.invoke(current);
    trace.push({ name: plugin.name, result: current });
  }

  return {
    chain: trace,
    finalResult: current,
    pluginCount: trace.length,
  };
}

function renderHtml() {
  return `<!doctype html>
  <html lang="zh-CN">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Plugin Mesh</title>
      <style>
        :root {
          color-scheme: light dark;
          --mesh-accent: #8250df;
          --mesh-accent-soft: color-mix(in srgb, var(--mesh-accent) 12%, transparent);
          --mesh-surface: var(--background-color-default, #ffffff);
          --mesh-subtle: var(--background-color-muted, #f6f8fa);
          --mesh-border: var(--border-color-default, #d0d7de);
          --mesh-text: var(--text-color-default, #1f2328);
          --mesh-muted: var(--text-color-muted, #656d76);
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          background: var(--mesh-surface);
          color: var(--mesh-text);
          font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
          font-size: var(--text-body-medium, 14px);
          line-height: 1.55;
        }
        .shell { max-width: 860px; margin: 0 auto; padding: 28px clamp(16px, 4vw, 36px) 40px; }
        .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
        .brand { display: flex; align-items: center; gap: 12px; }
        .brand-mark {
          display: grid; place-items: center; width: 42px; height: 42px; border-radius: 13px;
          background: var(--mesh-accent-soft); color: var(--mesh-accent); font-size: 20px; font-weight: 800;
        }
        .brand-title { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -.02em; }
        .brand-subtitle { margin: 2px 0 0; color: var(--mesh-muted); font-size: 12px; }
        .live { display: inline-flex; align-items: center; gap: 7px; color: var(--mesh-muted); font-size: 12px; white-space: nowrap; }
        .live::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #1a7f37; box-shadow: 0 0 0 3px color-mix(in srgb, #1a7f37 15%, transparent); }
        .intro { margin-bottom: 22px; }
        h1 { margin: 0; font-size: clamp(24px, 4vw, 32px); line-height: 1.2; letter-spacing: -.04em; }
        .intro p { color: var(--mesh-muted); margin: 8px 0 0; max-width: 560px; }
        .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 26px 0 12px; }
        h2 { margin: 0; font-size: 14px; font-weight: 700; }
        .count { color: var(--mesh-muted); font-size: 12px; }
        .plugin-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
        .plugin {
          min-width: 0; padding: 14px; border: 1px solid var(--mesh-border); border-radius: 12px;
          background: var(--mesh-surface); transition: border-color .15s, transform .15s;
        }
        .plugin:hover { border-color: color-mix(in srgb, var(--mesh-accent) 55%, var(--mesh-border)); transform: translateY(-1px); }
        .plugin-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .plugin-name { font-family: var(--font-mono, monospace); font-size: 13px; font-weight: 700; overflow-wrap: anywhere; }
        .badge { padding: 2px 8px; border-radius: 999px; background: var(--mesh-subtle); color: var(--mesh-muted); font-size: 10px; }
        .plugin p { margin: 8px 0 0; color: var(--mesh-muted); font-size: 12px; }
        .panel {
          margin-top: 24px; border: 1px solid var(--mesh-border); border-radius: 14px;
          background: var(--mesh-surface); overflow: hidden;
        }
        .panel-heading { padding: 16px 18px; border-bottom: 1px solid var(--mesh-border); }
        .panel-heading p { margin: 4px 0 0; color: var(--mesh-muted); font-size: 12px; }
        .form { padding: 18px; }
        label { display: block; margin: 0 0 7px; font-size: 12px; font-weight: 650; }
        .field + .field { margin-top: 15px; }
        input, textarea {
          display: block; width: 100%; border: 1px solid var(--mesh-border); border-radius: 9px;
          padding: 10px 12px; font: inherit; font-size: 13px; background: var(--mesh-surface); color: var(--mesh-text);
          outline: none; transition: border-color .15s, box-shadow .15s;
        }
        textarea { resize: vertical; min-height: 112px; font-family: var(--font-mono, monospace); font-size: 12px; }
        input:focus, textarea:focus { border-color: var(--mesh-accent); box-shadow: 0 0 0 3px var(--mesh-accent-soft); }
        .actions { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
        button {
          display: inline-flex; align-items: center; justify-content: center; gap: 8px;
          border: 0; border-radius: 9px; padding: 10px 15px; background: var(--mesh-accent);
          color: #fff; font: inherit; font-size: 13px; font-weight: 650; cursor: pointer;
          transition: filter .15s, transform .15s;
        }
        button:hover { filter: brightness(1.08); }
        button:active { transform: translateY(1px); }
        button:disabled { opacity: .65; cursor: wait; }
        .hint { color: var(--mesh-muted); font-size: 11px; }
        .result-wrap { display: none; padding: 0 18px 18px; }
        .result-wrap.visible { display: block; }
        .result-title { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 12px; font-weight: 650; }
        .result { margin: 0; border: 1px solid var(--mesh-border); border-radius: 9px; padding: 13px;
          background: var(--mesh-subtle); color: var(--mesh-text); font: 12px/1.55 var(--font-mono, monospace);
          white-space: pre-wrap; overflow-wrap: anywhere; max-height: 280px; overflow: auto; }
        .error { color: var(--color-danger-fg, #cf222e); }
        @media (max-width: 520px) {
          .shell { padding-top: 20px; }
          .topbar { align-items: flex-start; }
          .live { padding-top: 7px; }
          .actions { align-items: flex-start; flex-direction: column; }
        }
      </style>
    </head>
    <body>
      <main class="shell">
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark" aria-hidden="true">⌘</div>
            <div><p class="brand-title">Plugin Mesh</p><p class="brand-subtitle">Copilot extension</p></div>
          </div>
          <span class="live">运行中</span>
        </header>
        <section class="intro">
          <h1>插件工作台</h1>
          <p>查看已注册的插件，并将它们串联起来执行。每个插件的输出会成为下一个插件的输入。</p>
        </section>
        <section aria-labelledby="plugins-heading">
          <div class="section-heading">
            <h2 id="plugins-heading">已注册插件</h2>
            <span class="count" id="plugin-count">加载中…</span>
          </div>
          <div class="plugin-grid" id="plugin-list" aria-live="polite"></div>
        </section>
        <section class="panel" aria-labelledby="run-heading">
          <div class="panel-heading">
            <h2 id="run-heading">运行插件链</h2>
            <p>按顺序输入插件名称，用逗号分隔。</p>
          </div>
          <form class="form" id="run-form">
            <div class="field">
              <label for="plugin-input">执行顺序</label>
              <input id="plugin-input" value="echo, ping" autocomplete="off" spellcheck="false" />
            </div>
            <div class="field">
              <label for="payload-input">初始输入</label>
              <textarea id="payload-input" spellcheck="false">{"message":"hello"}</textarea>
            </div>
            <div class="actions">
              <button id="run-button" type="submit"><span aria-hidden="true">▶</span> 执行插件链</button>
              <span class="hint">JSON 或普通文本均可</span>
            </div>
          </form>
          <div class="result-wrap" id="result-wrap">
            <div class="result-title"><span>执行结果</span><span id="result-status"></span></div>
            <pre class="result" id="result-output"></pre>
          </div>
        </section>
      </main>

      <script>
        async function loadPlugins() {
          const list = document.getElementById("plugin-list");
          const count = document.getElementById("plugin-count");
          try {
            const response = await fetch("/api/plugins");
            if (!response.ok) throw new Error("无法读取插件列表");
            const data = await response.json();
            count.textContent = data.plugins.length + " 个插件";
            if (data.plugins.length === 0) {
              list.textContent = "暂无已注册插件";
              return;
            }
            for (const plugin of data.plugins) {
              const card = document.createElement("article");
              card.className = "plugin";
              const head = document.createElement("div");
              head.className = "plugin-head";
              const name = document.createElement("span");
              name.className = "plugin-name";
              name.textContent = plugin.name;
              const badge = document.createElement("span");
              badge.className = "badge";
              badge.textContent = plugin.kind === "builtin" ? "内置" : "自定义";
              const description = document.createElement("p");
              description.textContent = plugin.description;
              head.append(name, badge);
              card.append(head, description);
              list.append(card);
            }
          } catch (error) {
            count.textContent = "加载失败";
            list.textContent = error.message;
          }
        }

        async function runChain(event) {
          event.preventDefault();
          const button = document.getElementById("run-button");
          const resultWrap = document.getElementById("result-wrap");
          const output = document.getElementById("result-output");
          const status = document.getElementById("result-status");
          const names = document.getElementById("plugin-input").value.split(",").map((item) => item.trim()).filter(Boolean);
          const payload = (() => {
            try {
              return JSON.parse(document.getElementById("payload-input").value);
            } catch {
              return document.getElementById("payload-input").value;
            }
          })();

          resultWrap.classList.add("visible");
          output.classList.remove("error");
          status.textContent = "";
          button.disabled = true;
          button.textContent = "执行中…";
          try {
            const response = await fetch("/api/invoke", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ names, input: payload })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "插件执行失败");
            output.textContent = JSON.stringify(result, null, 2);
            status.textContent = "成功 · " + result.pluginCount + " 步";
          } catch (error) {
            output.textContent = error.message;
            output.classList.add("error");
            status.textContent = "执行失败";
          } finally {
            button.disabled = false;
            button.innerHTML = "<span aria-hidden=\"true\">▶</span> 执行插件链";
          }
        }

        document.getElementById("run-form").addEventListener("submit", runChain);
        loadPlugins();
      </script>
    </body>
  </html>`;
}

function startLoopbackServer(instanceId) {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/plugins') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ plugins: listCurrentPlugins() }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/invoke') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const result = await invokePluginChain(payload.names || payload.chain, payload.input);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown error';
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: message }));
        }
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHtml());
  });

  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolvePromise({
        server,
        url: `http://127.0.0.1:${address.port}/`,
      });
    });
  });
}

const pluginMeshCanvas = createCanvas({
  id: "plugin-mesh",
  displayName: "Plugin Mesh",
  description: "Inspect the active plugin registry and execute plugin chains.",
  actions: [
    {
      name: "list_plugins",
      description: "List all registered plugins in the mesh.",
      handler: async () => ({ plugins: listCurrentPlugins() }),
    },
    {
      name: "register_plugin",
      description: "Register a custom plugin in the mesh.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          description: { type: "string" },
          strategy: { type: "string", enum: ["identity", "uppercase", "lowercase", "reverse", "json"] },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (ctx) => {
        const { name, description = "Custom plugin", strategy = "identity" } = ctx.input ?? {};
        if (!name) {
          throw new CanvasError("plugin_name_required", "A plugin name is required.");
        }
        if (registry.has(name)) {
          throw new CanvasError("plugin_already_registered", `Plugin already registered: ${name}`);
        }

        const plugin = {
          name,
          kind: "custom",
          description,
          invoke: async (value) => runStrategy(strategy, value),
        };

        registry.set(name, plugin);
        persistRegistry();

        return {
          registered: true,
          plugin: { name, kind: plugin.kind, description },
        };
      },
    },
    {
      name: "invoke_plugin",
      description: "Run one or more plugins in sequence.",
      inputSchema: {
        type: "object",
        properties: {
          names: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
          },
          input: {},
        },
        required: ["names"],
        additionalProperties: false,
      },
      handler: async (ctx) => {
        const { names, input } = ctx.input ?? {};
        return invokePluginChain(names, input);
      },
    },
  ],
  open: async (ctx) => {
    let entry = servers.get(ctx.instanceId);
    if (!entry) {
      entry = await startLoopbackServer(ctx.instanceId);
      servers.set(ctx.instanceId, entry);
    }

    return {
      title: "Plugin Mesh",
      status: `${listCurrentPlugins().length} plugins loaded`,
      url: entry.url,
    };
  },
  onClose: async (ctx) => {
    const entry = servers.get(ctx.instanceId);
    if (entry) {
      servers.delete(ctx.instanceId);
      await new Promise((resolve) => entry.server.close(() => resolve()));
    }
  },
});

ensureStorage();

await joinSession({
  canvases: [pluginMeshCanvas],
  hooks: {
    onSessionStart: async () => ({
      additionalContext: `Plugin Mesh is active. Available built-in plugins: ${Object.keys(BUILTIN_PLUGINS).join(", ")}. Use list_plugins or invoke_plugin to inspect and execute the mesh.`,
    }),
  },
});
