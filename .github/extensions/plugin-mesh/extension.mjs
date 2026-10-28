import { createCanvas, joinSession, CanvasError } from "@github/copilot-sdk/extension";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createMeshRuntime } from "./mesh-runtime.mjs";
import { createMeshTaskSessionManager } from "./mesh-task-sessions.mjs";
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
const taskSessions = createMeshTaskSessionManager();
let extensionSession;
const mesh = createMeshRuntime({
  taskDispatcher: taskSessions.dispatch,
  onError: (error) => extensionSession?.log(`Mesh task dispatch failed: ${error.message}`, { level: "error" }),
});

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
        .checkbox-field { display: flex; align-items: flex-start; gap: 9px; margin: 12px 0 0; color: var(--mesh-text); font-size: 12px; }
        .checkbox-field input { width: auto; margin: 2px 0 0; padding: 0; accent-color: var(--mesh-accent); }
        .checkbox-field span { flex: 1; }
        input:not([type="checkbox"]), textarea {
          display: block; width: 100%; border: 1px solid var(--mesh-border); border-radius: 9px;
          padding: 10px 12px; font: inherit; font-size: 13px; background: var(--mesh-surface); color: var(--mesh-text);
          outline: none; transition: border-color .15s, box-shadow .15s;
        }
        textarea { resize: vertical; min-height: 112px; font-family: var(--font-mono, monospace); font-size: 12px; }
        input:not([type="checkbox"]):focus, textarea:focus { border-color: var(--mesh-accent); box-shadow: 0 0 0 3px var(--mesh-accent-soft); }
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
        .mesh-banner {
          margin: 14px 0 18px; padding: 12px 14px; border: 1px solid color-mix(in srgb, #bf8700 35%, var(--mesh-border));
          border-radius: 10px; background: color-mix(in srgb, #bf8700 8%, var(--mesh-surface)); color: var(--mesh-muted); font-size: 12px;
        }
        .mesh-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
        .meta-item { padding: 10px 12px; border: 1px solid var(--mesh-border); border-radius: 9px; background: var(--mesh-subtle); }
        .meta-label { color: var(--mesh-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
        .meta-value { margin-top: 3px; font: 12px/1.5 var(--font-mono, monospace); overflow-wrap: anywhere; }
        .peer-list, .task-list { display: grid; gap: 9px; margin-top: 12px; }
        .peer-item, .task-item { padding: 12px; border: 1px solid var(--mesh-border); border-radius: 10px; }
        .peer-item-head, .task-item-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
        .peer-endpoint { margin-top: 4px; color: var(--mesh-muted); font: 11px var(--font-mono, monospace); overflow-wrap: anywhere; }
        .task-text { margin: 10px 0 0; padding: 10px; border-radius: 8px; background: var(--mesh-subtle); white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.5 var(--font-mono, monospace); max-height: 180px; overflow: auto; }
        .task-status { color: var(--mesh-muted); font-size: 11px; }
        .subheading { margin-top: 20px; }
        .token-row { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
        .token-row code { min-width: 0; flex: 1; padding: 9px 10px; overflow-wrap: anywhere; border: 1px solid var(--mesh-border); border-radius: 8px; background: var(--mesh-subtle); font-size: 11px; }
        .secondary-button { border: 1px solid var(--mesh-border); background: var(--mesh-surface); color: var(--mesh-text); }
        .small-button { padding: 6px 9px; font-size: 11px; }
        select { display: block; width: 100%; padding: 10px 12px; border: 1px solid var(--mesh-border); border-radius: 9px; background: var(--mesh-surface); color: var(--mesh-text); font: inherit; }
        .empty { color: var(--mesh-muted); font-size: 12px; padding: 10px 0; }
        .mesh-feedback { min-height: 18px; color: var(--mesh-muted); font-size: 12px; }
        .mesh-feedback.error { color: var(--color-danger-fg, #cf222e); }
        .capability-note { margin: 10px 0 0; color: var(--mesh-muted); font-size: 11px; }
        .name-row { display: flex; gap: 8px; align-items: flex-end; }
        .name-row .field { flex: 1; min-width: 0; }
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
          <p>管理可信 Copilot 节点、收发任务请求，也可以串联本地插件。跨设备任务始终需要接收方人工审核。</p>
        </section>
        <section class="panel" aria-labelledby="mesh-heading">
          <div class="panel-heading">
            <h2 id="mesh-heading">Copilot Mesh 节点</h2>
            <p>自动发现同网段节点，也可手动扫描；发现不代表信任，配对仍需你提供对端令牌。</p>
          </div>
          <div class="form">
            <div class="mesh-meta" id="mesh-meta"><div class="empty">正在读取节点状态…</div></div>
            <p class="capability-note" id="capability-summary"></p>
            <div class="token-row">
              <code id="local-token">配对令牌已隐藏</code>
              <button class="secondary-button small-button" id="toggle-token" type="button">显示令牌</button>
            </div>
            <div class="mesh-banner">配对令牌通过 HTTP 明文传输，仅在可信私有网络使用。收到的任务只进入待审核收件箱，不会自动发送给 Copilot 或执行。</div>

            <form id="name-form" class="name-row">
              <div class="field"><label for="machine-name">本机名称</label><input id="machine-name" required maxlength="32" /></div>
              <button class="secondary-button small-button" type="submit">保存名称</button>
            </form>

            <div class="section-heading subheading"><h2>发现的节点</h2><button class="secondary-button small-button" id="scan-mesh" type="button">扫描本地网络</button></div>
            <div class="peer-list" id="discovered-list"></div>
            <div class="section-heading subheading"><h2>已配对节点</h2><button class="secondary-button small-button" id="refresh-mesh" type="button">刷新</button></div>
            <div class="peer-list" id="peer-list"></div>

            <form id="peer-form">
                      <div class="field"><label for="peer-name">节点名称</label><input id="peer-name" required maxlength="32" placeholder="例如：Office Mac" /></div>
              <div class="field"><label for="peer-url">对端地址</label><input id="peer-url" required placeholder="http://192.168.1.20:45917" /></div>
              <div class="field"><label for="peer-token">对端配对令牌</label><input id="peer-token" required autocomplete="off" spellcheck="false" placeholder="粘贴对端面板显示的令牌" /></div>
              <div class="actions"><button type="submit">验证并配对</button></div>
            </form>

            <div class="section-heading subheading"><h2>派发任务</h2><span class="count">按对端策略处理</span></div>
            <form id="task-form">
              <div class="field"><label for="task-peer">目标节点</label><select id="task-peer" required></select></div>
              <div class="field"><label for="task-thread">线程标签（可选）</label><input id="task-thread" maxlength="128" placeholder="用于关联同一件事的后续请求" /></div>
              <div class="field"><label for="task-text">任务请求</label><textarea id="task-text" maxlength="262144" required placeholder="写下你希望对端隔离任务会话处理的请求…"></textarea></div>
              <label class="checkbox-field" for="task-no-wake"><input id="task-no-wake" type="checkbox" /><span>仅记录在对端收件箱，不唤醒 agent（noWake）</span></label>
              <div class="mesh-banner">默认按 DSH Mesh 协议发送普通任务；对端策略可能会唤醒 agent 或创建会话。只向你信任的节点派发。勾选 noWake 可要求对端仅记录。</div>
              <div class="actions"><button type="submit">发送任务</button><span class="hint">送达不代表任务已完成。</span></div>
            </form>
            <div id="mesh-feedback" class="mesh-feedback" role="status"></div>

            <div class="section-heading subheading"><h2>待审核收件箱</h2><span class="count">外部请求按不可信内容展示</span></div>
            <div class="task-list" id="inbox-list"></div>
            <div class="section-heading subheading"><h2>发送记录</h2></div>
            <div class="task-list" id="sent-list"></div>
          </div>
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

        let meshToken = "";
        let tokenVisible = false;

        function setMeshFeedback(message, isError = false) {
          const feedback = document.getElementById("mesh-feedback");
          feedback.textContent = message;
          feedback.classList.toggle("error", isError);
        }

        function metaItem(label, value) {
          const item = document.createElement("div");
          item.className = "meta-item";
          const title = document.createElement("div");
          title.className = "meta-label";
          title.textContent = label;
          const content = document.createElement("div");
          content.className = "meta-value";
          content.textContent = value;
          item.append(title, content);
          return item;
        }

        function renderPeers(peers) {
          const list = document.getElementById("peer-list");
          const select = document.getElementById("task-peer");
          const selectedPeer = select.value;
          list.replaceChildren();
          select.replaceChildren();
          const prompt = document.createElement("option");
          prompt.value = "";
          prompt.textContent = peers.length ? "选择一个已配对节点" : "先添加并配对节点";
          select.append(prompt);
          for (const peer of peers) {
            const option = document.createElement("option");
            option.value = peer.id;
            option.textContent = peer.name + " · " + peer.status;
            select.append(option);

            const card = document.createElement("article");
            card.className = "peer-item";
            const head = document.createElement("div");
            head.className = "peer-item-head";
            const info = document.createElement("div");
            const name = document.createElement("strong");
            name.textContent = peer.name;
            const endpoint = document.createElement("div");
            endpoint.className = "peer-endpoint";
            endpoint.textContent = peer.url + " · " + peer.status;
            info.append(name, endpoint);
            const remove = document.createElement("button");
            remove.className = "secondary-button small-button";
            remove.type = "button";
            remove.textContent = "探测";
            remove.addEventListener("click", async () => {
              try {
                await meshRequest("/api/mesh/peer/refresh", { id: peer.id });
                await loadMesh();
                setMeshFeedback("节点探测完成。");
              } catch (error) {
                setMeshFeedback(error.message, true);
              }
            });
            const forget = document.createElement("button");
            forget.className = "secondary-button small-button";
            forget.type = "button";
            forget.textContent = "移除";
            forget.addEventListener("click", async () => {
              try {
                await meshRequest("/api/mesh/peer/remove", { id: peer.id });
                await loadMesh();
                setMeshFeedback("已移除配对节点。");
              } catch (error) {
                setMeshFeedback(error.message, true);
              }
            });
            const buttons = document.createElement("div");
            buttons.className = "actions";
            buttons.append(remove, forget);
            head.append(info, buttons);
            card.append(head);
            if (peer.capabilities || peer.capabilitiesStale === null) {
              const details = document.createElement("div");
              details.className = "peer-endpoint";
              details.textContent = [
                peer.os || peer.capabilities?.os || "系统未知",
                peer.capabilities?.cpuCount ? peer.capabilities.cpuCount + " 核" : "",
                peer.capabilities?.runtimes ? Object.entries(peer.capabilities.runtimes).map(([key, value]) => key + " " + value).join(" · ") : "",
                peer.capabilitiesStale === null ? "能力未知" : peer.capabilitiesStale ? "能力信息已过期" : ""
              ].filter(Boolean).join(" · ");
              card.append(details);
            }
            list.append(card);
          }
          if (peers.some((peer) => peer.id === selectedPeer)) select.value = selectedPeer;
          if (!peers.length) {
            const empty = document.createElement("div");
            empty.className = "empty";
            empty.textContent = "尚未配对节点。请在另一台 Copilot 上安装此扩展，并将它的私有 IP、端口和配对令牌添加到这里。";
            list.append(empty);
          }
        }

        function renderDiscovered(peers) {
          const list = document.getElementById("discovered-list");
          list.replaceChildren();
          for (const peer of peers) {
            const card = document.createElement("article");
            card.className = "peer-item";
            const head = document.createElement("div");
            head.className = "peer-item-head";
            const info = document.createElement("div");
            const name = document.createElement("strong");
            name.textContent = peer.name;
            const endpoint = document.createElement("div");
            endpoint.className = "peer-endpoint";
            endpoint.textContent = peer.host + ":" + peer.port + " · " + peer.status;
            info.append(name, endpoint);
            const pair = document.createElement("button");
            pair.className = "secondary-button small-button";
            pair.type = "button";
            pair.textContent = "手动配对";
            pair.addEventListener("click", () => {
              document.getElementById("peer-name").value = peer.name;
              document.getElementById("peer-url").value = "http://" + peer.host + ":" + peer.port;
              document.getElementById("peer-token").focus();
            });
            head.append(info, pair);
            card.append(head);
            if (peer.capabilities || peer.capabilitiesStale === null) {
              const details = document.createElement("div");
              details.className = "peer-endpoint";
              details.textContent = [
                peer.capabilities?.os || "系统未知",
                peer.capabilities?.cpuCount ? peer.capabilities.cpuCount + " 核" : "",
                peer.capabilities?.runtimes ? Object.entries(peer.capabilities.runtimes).map(([key, value]) => key + " " + value).join(" · ") : "",
                peer.capabilitiesStale === null ? "能力未知" : peer.capabilitiesStale ? "能力信息已过期" : ""
              ].filter(Boolean).join(" · ");
              card.append(details);
            }
            list.append(card);
          }
          if (!peers.length) {
            const empty = document.createElement("div");
            empty.className = "empty";
            empty.textContent = "暂未发现节点。检查两台设备是否处于同一局域网，或启动本地网络扫描。";
            list.append(empty);
          }
        }

        function renderTasks(containerId, tasks, inbox = false) {
          const container = document.getElementById(containerId);
          container.replaceChildren();
          for (const task of tasks) {
            const card = document.createElement("article");
            card.className = "task-item";
            const head = document.createElement("div");
            head.className = "task-item-head";
            const title = document.createElement("strong");
            title.textContent = inbox ? (task.fromName || "对端请求") : (task.peerName || "发送请求");
            const status = document.createElement("span");
            status.className = "task-status";
            status.textContent = task.status + " · " + (task.receivedAt || task.sentAt || "");
            if (task.noWake === true) status.textContent += " · noWake";
            if (task.thread) status.textContent += " · thread " + task.thread;
            head.append(title, status);
            const body = document.createElement("pre");
            body.className = "task-text";
            body.textContent = task.task;
            card.append(head, body);
            if (inbox && (task.routeDecision || task.dispatchError)) {
              const decision = document.createElement("small");
              decision.textContent = task.dispatchError || task.routeDecision;
              card.append(decision);
            }
            if (inbox && task.result) {
              const result = document.createElement("pre");
              result.className = "task-text";
              result.textContent = "隔离会话回复：\n" + task.result;
              card.append(result);
            }
            if (inbox && ["awaiting-review", "failed", "rate-limited"].includes(task.status)) {
              const actions = document.createElement("div");
              actions.className = "actions";
              const copy = document.createElement("button");
              copy.className = "secondary-button small-button";
              copy.type = "button";
              copy.textContent = "复制请求";
              copy.addEventListener("click", async () => {
                try {
                  await navigator.clipboard.writeText(task.task);
                  setMeshFeedback("请求已复制；请检查内容后再决定是否交给 Copilot。");
                } catch {
                  setMeshFeedback("无法访问剪贴板，请手动选择并复制请求内容。", true);
                }
              });
              const dismiss = document.createElement("button");
              dismiss.className = "secondary-button small-button";
              dismiss.type = "button";
              dismiss.textContent = "忽略";
              dismiss.addEventListener("click", async () => {
                try {
                  await meshRequest("/api/mesh/task/dismiss", { id: task.id });
                  await loadMesh();
                  setMeshFeedback("已忽略该请求。");
                } catch (error) {
                  setMeshFeedback(error.message, true);
                }
              });
              actions.append(copy, dismiss);
              card.append(actions);
            }
            container.append(card);
          }
          if (!tasks.length) {
            const empty = document.createElement("div");
            empty.className = "empty";
            empty.textContent = inbox ? "收件箱为空。" : "暂无发送记录。";
            container.append(empty);
          }
        }

        async function meshRequest(path, body) {
          const response = await fetch(path, {
            method: body ? "POST" : "GET",
            headers: body ? { "Content-Type": "application/json" } : {},
            body: body ? JSON.stringify(body) : undefined
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Mesh 请求失败");
          return result;
        }

        async function loadMesh() {
          try {
            const state = await meshRequest("/api/mesh/state");
            meshToken = state.token;
            document.getElementById("mesh-meta").replaceChildren(
              metaItem("节点名称", state.name),
              metaItem("节点 ID", state.nodeId),
              metaItem("监听地址", state.addresses.length ? state.addresses.map((ip) => "http://" + ip + ":" + state.port).join("\\n") : "未发现私有网卡地址"),
              metaItem("端口", String(state.port))
            );
            if (document.activeElement !== document.getElementById("machine-name")) {
              document.getElementById("machine-name").value = state.name;
            }
            const capabilities = state.capabilities;
            document.getElementById("capability-summary").textContent = capabilities
              ? "本机能力：" + capabilities.os + " · " + capabilities.cpuCount + " CPU · " + Math.round(capabilities.memoryBytes / 1024 ** 3) + " GB RAM · " + Object.entries(capabilities.runtimes).map(([key, value]) => key + " " + value).join(" · ")
              : "本机能力暂不可用。";
            document.getElementById("local-token").textContent = tokenVisible ? meshToken : "配对令牌已隐藏";
            renderPeers(state.peers);
            renderDiscovered(state.discovered);
            renderTasks("inbox-list", state.inbox, true);
            renderTasks("sent-list", state.sent);
          } catch (error) {
            setMeshFeedback(error.message, true);
          }
        }

        document.getElementById("toggle-token").addEventListener("click", () => {
          tokenVisible = !tokenVisible;
          document.getElementById("local-token").textContent = tokenVisible ? meshToken : "配对令牌已隐藏";
          document.getElementById("toggle-token").textContent = tokenVisible ? "隐藏令牌" : "显示令牌";
        });
        document.getElementById("name-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          try {
            const result = await meshRequest("/api/mesh/name", { name: document.getElementById("machine-name").value });
            await loadMesh();
            setMeshFeedback("本机名称已更新为 " + result.name + "。");
          } catch (error) {
            setMeshFeedback(error.message, true);
          }
        });
        document.getElementById("scan-mesh").addEventListener("click", async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          button.textContent = "扫描中…";
          try {
            const result = await meshRequest("/api/mesh/scan", {});
            await loadMesh();
            setMeshFeedback("扫描完成：检查 " + result.scanned + " 个地址，发现 " + result.found + " 个节点。");
          } catch (error) {
            setMeshFeedback(error.message, true);
          } finally {
            button.disabled = false;
            button.textContent = "扫描本地网络";
          }
        });
        document.getElementById("refresh-mesh").addEventListener("click", async () => {
          try {
            const state = await meshRequest("/api/mesh/state");
            await Promise.all(state.peers.map((peer) => meshRequest("/api/mesh/peer/refresh", { id: peer.id }).catch(() => undefined)));
            await loadMesh();
            setMeshFeedback("节点状态已刷新。");
          } catch (error) {
            setMeshFeedback(error.message, true);
          }
        });
        document.getElementById("peer-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          try {
            await meshRequest("/api/mesh/peer", {
              name: document.getElementById("peer-name").value,
              url: document.getElementById("peer-url").value,
              token: document.getElementById("peer-token").value
            });
            document.getElementById("peer-form").reset();
            await loadMesh();
            setMeshFeedback("已验证并配对节点。");
          } catch (error) {
            setMeshFeedback(error.message, true);
          }
        });
        document.getElementById("task-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          try {
            const result = await meshRequest("/api/mesh/task", {
              peerId: document.getElementById("task-peer").value,
              thread: document.getElementById("task-thread").value,
              task: document.getElementById("task-text").value,
              noWake: document.getElementById("task-no-wake").checked
            });
            document.getElementById("task-text").value = "";
            await loadMesh();
            setMeshFeedback(result.message);
          } catch (error) {
            setMeshFeedback(error.message, true);
          }
        });

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
            button.textContent = "▶ 执行插件链";
          }
        }

        document.getElementById("run-form").addEventListener("submit", runChain);
        loadPlugins();
        loadMesh();
        window.setInterval(loadMesh, 3000);
      </script>
    </body>
  </html>`;
}

function startLoopbackServer(instanceId) {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/mesh/state") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(mesh.localState({ includeToken: true })));
      return;
    }

    const meshActions = {
      "/api/mesh/name": (body) => mesh.setName(body.name),
      "/api/mesh/scan": () => mesh.scan(),
      "/api/mesh/peer": (body) => mesh.addPeer(body),
      "/api/mesh/peer/remove": (body) => mesh.removePeer(body.id),
      "/api/mesh/peer/refresh": (body) => mesh.refreshPeer(body.id),
      "/api/mesh/task": (body) => mesh.sendTask(body),
      "/api/mesh/task/dismiss": (body) => mesh.dismissTask(body.id),
    };
    if (req.method === "POST" && Object.hasOwn(meshActions, req.url)) {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          if (Buffer.byteLength(body, "utf8") > 270 * 1024) throw new Error("Request body exceeds 270 KiB.");
          const payload = JSON.parse(body || "{}");
          const result = await meshActions[req.url](payload);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

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
  displayName: "Copilot Mesh",
  description: "Pair Copilot nodes, review incoming task requests, and run local plugin chains.",
  actions: [
    {
      name: "mesh_status",
      description: "Show this Copilot node's identity, private addresses, and paired peers. Never returns pairing tokens.",
      handler: async () => mesh.localState(),
    },
    {
      name: "mesh_peers",
      description: "List discovered and manually paired mesh peers, including online status and reported capabilities.",
      handler: async () => {
        const state = mesh.localState();
        return { peers: state.peers, discovered: state.discovered };
      },
    },
    {
      name: "mesh_tasks",
      description: "List received task requests and outgoing dispatch records.",
      handler: async () => {
        const { inbox, sent } = mesh.localState();
        return { inbox, sent };
      },
    },
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
      title: "Copilot Mesh",
      status: `${mesh.localState().peers.length} paired peers · ${mesh.localState().port}`,
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
await mesh.initialize();
await mesh.listen();

extensionSession = await joinSession({
  canvases: [pluginMeshCanvas],
  hooks: {
    onSessionStart: async () => ({
      additionalContext: `Copilot Mesh is active. LAN peers may be discovered automatically, but control and outbound task dispatch require manual pairing. Incoming tasks follow DSH Mesh wake policy and run in a separate named Copilot session; no remote task is injected into this conversation. Task sessions keep tools available by default, matching DSH's workspace-write permission preset; set COPILOT_MESH_TASK_TOOLS=none to run them without tools. A completed task is returned to the sender once as a noWake notice, and a receipt is never answered again. noWake, short notices, and thread limits may keep an incoming task in the inbox. Outgoing tasks follow DSH Mesh defaults (noWake: false unless selected). Mesh read-only actions: mesh_status, mesh_peers, and mesh_tasks. Scan, pair peers, and send requests manually in the Copilot Mesh canvas. Local built-in plugins: ${Object.keys(BUILTIN_PLUGINS).join(", ")}.`,
    }),
    onSessionEnd: async () => {
      try {
        await taskSessions.close();
      } finally {
        await mesh.close();
      }
    },
  },
});
