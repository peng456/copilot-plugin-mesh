import { access, mkdir, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// The SDK only resolves inside the Copilot runtime, so it is loaded lazily to
// keep this module importable from plain Node (tests, diagnostics).

function copilotHome() {
  return process.env.COPILOT_HOME || join(homedir(), ".copilot");
}

function defaultConfigDirectory() {
  return join(copilotHome(), "extensions", "plugin-mesh", "artifacts", "task-session-config");
}

// dsh-plugin-mesh runs inbound tasks in a dedicated `mesh-receive-task`
// workspace per profile rather than the project checkout, so the
// workspace-write preset confines writes to that scratch directory.
function defaultWorkingDirectory() {
  return join(copilotHome(), "extensions", "plugin-mesh", "artifacts", "mesh-receive-task");
}

function runtimeCacheRoots() {
  const cacheRoot = process.platform === "win32"
    ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return ["cli", "runtime"].map((directory) =>
    join(cacheRoot, "github-copilot-sdk", directory),
  );
}

async function findCachedRuntime() {
  const executable = process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime";
  const candidates = [];
  for (const root of runtimeCacheRoots()) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("copilot-sdk-runtime-")) continue;
      const path = join(root, entry.name, executable);
      try {
        await access(path);
        candidates.push({ path, modifiedAt: (await stat(path)).mtimeMs });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return candidates[0]?.path;
}

async function createClient(options) {
  const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
  const runtimePath = process.env.COPILOT_CLI_PATH || await findCachedRuntime();
  return new CopilotClient({
    ...(runtimePath ? { connection: RuntimeConnection.forStdio({ path: resolve(runtimePath) }) } : {}),
    baseDirectory: options.baseDirectory,
    workingDirectory: options.workingDirectory,
    useLoggedInUser: true,
  });
}

function sessionName(task) {
  if (typeof task.sessionName === "string" && task.sessionName.trim().length > 0) {
    return task.sessionName.trim().slice(0, 120);
  }
  const origin = (task.fromName || "peer").replace(/[\u0000-\u001f\u007f"]/g, " ").trim().slice(0, 40);
  const thread = (task.thread || task.id).replace(/[\u0000-\u001f\u007f"]/g, " ").trim().slice(0, 40);
  return `Mesh · ${origin || "peer"} · ${thread || task.id}`;
}

// dsh-plugin-mesh runs every inbound task session under `permissionPreset`
// (default "workspace-write"): one config value, never derived from pairing.
// COPILOT_MESH_TASK_TOOLS=none is the equivalent of lowering that preset.
function resolveToolPolicy() {
  const override = (process.env.COPILOT_MESH_TASK_TOOLS || "").trim().toLowerCase();
  if (override === "none" || override === "off") return "none";
  return "all";
}

function withinRoot(root, target) {
  if (typeof target !== "string" || target.length === 0) return false;
  const path = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const relativePath = relative(root, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

// dsh-plugin-mesh hands the runtime `permissionPreset: workspace-write`, which
// is an operating-system sandbox: the task reads freely, writes only inside its
// receive workspace, and has no network. `sandboxConfig` is the same mechanism
// here, so the preset maps onto it one-to-one.
function workspaceWriteSandbox(workingDirectory) {
  return {
    enabled: true,
    addCurrentWorkingDirectory: true,
    allowBypass: false,
    userPolicy: {
      filesystem: { readwritePaths: [workingDirectory] },
      network: { allowOutbound: false, allowLocalNetwork: false },
    },
  };
}

// Where the sandbox is unavailable the runtime falls back to permission
// prompts, and a headless task has nobody to answer one. Approve the same
// boundary the sandbox would enforce, and reject the rest with a reason the
// agent can act on instead of leaving the turn hanging.
function workspaceWritePermissionHandler(root) {
  const workspace = resolve(root);
  const temporary = resolve(tmpdir());
  const writable = (target) => withinRoot(workspace, target) || withinRoot(temporary, target);
  const outside = (what) => ({
    kind: "reject",
    feedback: `${what} is outside the mesh receive workspace (${workspace}), which is the only writable area for this task.`,
  });
  return (request) => {
    if (request?.managedApprovalRequired) return { kind: "no-result" };
    if (request?.sandboxPathGrant) return outside("That path grant");
    if (request?.requestSandboxBypass) return outside("Leaving the sandbox");
    switch (request?.kind) {
      case "read":
        return { kind: "approve-once" };
      case "write":
        return writable(request.resolvedPath || request.fileName)
          ? { kind: "approve-once" }
          : outside(`Writing ${request.resolvedPath || request.fileName}`);
      case "shell": {
        const paths = [...(request.possiblePaths || []), request.resolvedWorkingDirectory]
          .filter((path) => typeof path === "string" && path.length > 0);
        const escaped = paths.find((path) => !writable(path));
        if (escaped) return outside(`Touching ${escaped}`);
        const urls = (request.possibleUrls || []).filter((entry) => entry?.url);
        if (urls.length > 0) {
          return { kind: "reject", feedback: "Network access is closed in the mesh receive workspace." };
        }
        return { kind: "approve-once" };
      }
      default:
        return { kind: "no-result" };
    }
  };
}

// Mirrors dsh-plugin-mesh's buildPrompt: only the actionable lines, and a
// receipt gets the opposite instruction from a new task.
function taskPrompt(task, toolPolicy) {
  const id = task.id;
  const from = task.fromName || task.from || "unknown";
  const thread = task.thread || id;
  return [
    `[Mesh task ${id}]`,
    `From: ${from}`,
    task.thread ? `Thread: ${task.thread}` : "",
    "",
    String(task.task ?? ""),
    "",
    toolPolicy === "all"
      ? "Tools are available. Inspect and act only as the request requires."
      : "This session has no tools available. Do not claim to have performed actions or accessed data.",
    task.isReply === true
      ? "— This is a receipt, not a new task: relay it to the user. Do not send anything back."
      : `— Your final message is returned to ${from} once (thread ${thread}). Answer directly; do not dispatch anything.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// A dispatch opens its local conversation before the peer is contacted, so the
// request and the answer share one transcript. The turn only records the
// outbound message; it is not work for the local agent to carry out. The
// closing line is what stops the agent treating the quoted request as a local
// task, which dsh-plugin-mesh reports happening without it.
function outboundPrompt(record) {
  const peer = record.peerName || "peer";
  return [
    `向 ${peer} 发送的消息 如下:`,
    String(record.task ?? ""),
    "———",
    `[Mesh 已派发 → ${peer}／${record.id}] 现在什么都不用做：不要调用任何工具、不要回派，回一句「等待回执」即可。`,
  ].join("\n");
}

export function createMeshTaskSessionManager(options = {}) {
  const workingDirectory = options.workingDirectory || defaultWorkingDirectory();
  const baseDirectory = options.baseDirectory || copilotHome();
  // The user's own MCP servers (mcp-config.json) can block a turn from ever
  // starting in a headless session, so isolated task sessions get their own
  // empty config directory instead of discovering the user's settings.
  const configDirectory = options.configDirectory || defaultConfigDirectory();
  const baseConfig = {
    configDirectory,
    workingDirectory,
    skipCustomInstructions: true,
    sandboxConfig: workspaceWriteSandbox(workingDirectory),
    onPermissionRequest: workspaceWritePermissionHandler(workingDirectory),
  };

  let clientPromise;
  const activeSessions = new Map();
  const sessionsById = new Map();
  const sessionPolicies = new Map();
  const queues = new Map();
  let closed = false;

  async function getClient() {
    if (closed) throw new Error("Mesh task-session manager is closed.");
    clientPromise ??= (async () => {
      if (options.clientFactory) return options.clientFactory({ baseDirectory, workingDirectory, configDirectory });
      await mkdir(configDirectory, { recursive: true });
      await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
      return createClient({ baseDirectory, workingDirectory });
    })();
    return clientPromise;
  }

  async function resumeOrCreate(task, context, toolPolicy) {
    const client = await getClient();
    const sessionConfig = {
      ...baseConfig,
      ...(toolPolicy === "all" ? {} : { availableTools: [] }),
    };
    const slot = `${context.routeKey}\0${toolPolicy}`;
    // dsh-plugin-mesh reuses a thread's session unconditionally, and the tool
    // policy is a process-wide setting, so only a *changed* setting needs a
    // fresh session. Sessions restored from persisted state carry no policy.
    const known = context.sessionId ? sessionPolicies.get(context.sessionId) : undefined;
    const reusable = context.sessionId ? known === undefined || known === toolPolicy : true;
    if (context.createSession !== true) {
      const active = context.sessionId
        ? reusable ? sessionsById.get(context.sessionId) : undefined
        : activeSessions.get(slot);
      if (active) return active;
      if (context.sessionId && reusable) {
        try {
          const resumed = await client.resumeSession(context.sessionId, sessionConfig);
          sessionsById.set(resumed.sessionId, resumed);
          sessionPolicies.set(resumed.sessionId, toolPolicy);
          activeSessions.set(slot, resumed);
          return resumed;
        } catch (error) {
          if (!/session.*(not found|does not exist)|not found/i.test(error.message)) throw error;
        }
      }
    }

    const created = await client.createSession({
      name: sessionName(task),
      ...sessionConfig,
    });
    sessionsById.set(created.sessionId, created);
    sessionPolicies.set(created.sessionId, toolPolicy);
    activeSessions.set(slot, created);
    return created;
  }

  async function dispatch(task, context) {
    const toolPolicy = resolveToolPolicy();
    const previous = queues.get(context.routeKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const session = await resumeOrCreate(task, context, toolPolicy);
      await context.onSessionCreated(session.sessionId);
      const response = await session.sendAndWait(
        { prompt: taskPrompt(task, toolPolicy) },
        120_000,
      );
      const content = response?.data?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error("The isolated task session returned no text response.");
      }
      return { sessionId: session.sessionId, result: content, toolPolicy };
    });
    queues.set(context.routeKey, current);
    try {
      return await current;
    } finally {
      if (queues.get(context.routeKey) === current) queues.delete(context.routeKey);
    }
  }

  // Mirrors dispatch, but the prompt is a record rather than a task, and the
  // session is reused so repeated dispatches to one peer and thread build a
  // single conversation.
  async function openConversation(record, context) {
    const toolPolicy = resolveToolPolicy();
    const previous = queues.get(context.routeKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const session = await resumeOrCreate(record, context, toolPolicy);
      await context.onSessionCreated(session.sessionId);
      await session.sendAndWait({ prompt: outboundPrompt(record) }, 120_000);
      return { sessionId: session.sessionId, toolPolicy };
    });
    queues.set(context.routeKey, current);
    try {
      return await current;
    } finally {
      if (queues.get(context.routeKey) === current) queues.delete(context.routeKey);
    }
  }

  async function close() {
    closed = true;
    const sessions = [...new Set(sessionsById.values())];
    sessionsById.clear();
    sessionPolicies.clear();
    activeSessions.clear();
    await Promise.allSettled(sessions.map((session) => session.disconnect()));
    if (clientPromise) {
      const client = await clientPromise;
      const errors = await client.stop();
      if (errors.length > 0) throw new AggregateError(errors, "Failed to stop the Mesh task-session runtime.");
    }
  }

  return { dispatch, openConversation, close };
}
