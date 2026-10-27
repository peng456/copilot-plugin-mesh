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
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Plugin Mesh</title>
      <style>
        body {
          margin: 0;
          background: var(--background-color-default, #ffffff);
          color: var(--text-color-default, #1f2328);
          font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
          font-size: var(--text-body-medium, 14px);
          line-height: 1.5;
          padding: 24px;
        }
        .card {
          border: 1px solid var(--border-color-default, #d0d7de);
          border-radius: 12px;
          padding: 16px;
          background: var(--background-color-default, #fff);
          box-shadow: 0 1px 2px rgba(31, 35, 40, 0.04);
          margin-bottom: 16px;
        }
        h1 { margin-top: 0; font-size: 24px; }
        label { display: block; margin-top: 12px; margin-bottom: 6px; font-weight: 600; }
        input, button, textarea {
          width: 100%;
          box-sizing: border-box;
          border: 1px solid var(--border-color-default, #d0d7de);
          border-radius: 8px;
          padding: 10px 12px;
          font: inherit;
          background: transparent;
          color: inherit;
        }
        button {
          cursor: pointer;
          background: var(--color-white, #fff);
          font-weight: 600;
          width: auto;
          margin-top: 12px;
        }
        pre {
          white-space: pre-wrap;
          background: rgba(31, 35, 40, 0.04);
          border-radius: 8px;
          padding: 12px;
          overflow: auto;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Plugin Mesh</h1>
        <p>Registry-based plugin orchestration for Copilot extensions.</p>
        <div id="plugin-list">Loading plugins…</div>
      </div>

      <div class="card">
        <label for="plugin-input">Plugin chain (comma-separated)</label>
        <input id="plugin-input" value="echo,ping" />
        <label for="payload-input">Payload</label>
        <textarea id="payload-input" rows="5">{"message":"hello"}</textarea>
        <button id="run-button">Invoke chain</button>
        <pre id="result-output">{}</pre>
      </div>

      <script>
        async function loadPlugins() {
          const res = await fetch('/api/plugins');
          const data = await res.json();
          const list = document.getElementById('plugin-list');
          list.innerHTML = data.plugins.map((plugin) => '<div><strong>' + plugin.name + '</strong> · ' + plugin.kind + ' · ' + plugin.description + '</div>').join('') || 'No plugins registered.';
        }

        async function runChain() {
          const names = document.getElementById('plugin-input').value.split(',').map((item) => item.trim()).filter(Boolean);
          const payload = (() => {
            try {
              return JSON.parse(document.getElementById('payload-input').value);
            } catch {
              return document.getElementById('payload-input').value;
            }
          })();

          const response = await fetch('/api/invoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ names, input: payload })
          });

          const result = await response.json();
          document.getElementById('result-output').textContent = JSON.stringify(result, null, 2);
        }

        document.getElementById('run-button').addEventListener('click', runChain);
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
