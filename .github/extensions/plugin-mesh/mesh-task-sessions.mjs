import { access, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The SDK only resolves inside the Copilot runtime, so it is loaded lazily to
// keep this module importable from plain Node (tests, diagnostics).

function copilotHome() {
  return process.env.COPILOT_HOME || join(homedir(), ".copilot");
}

function defaultConfigDirectory() {
  return join(copilotHome(), "extensions", "plugin-mesh", "artifacts", "task-session-config");
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
  const origin = (task.fromName || "peer").replace(/[\u0000-\u001f\u007f"]/g, " ").trim().slice(0, 40);
  const thread = (task.thread || task.id).replace(/[\u0000-\u001f\u007f"]/g, " ").trim().slice(0, 40);
  return `Mesh · ${origin || "peer"} · ${thread || task.id}`;
}

// A paired peer holds our token, so it may use tools. An unpaired peer on the
// LAN can only get a text answer; otherwise any device on the network could
// run commands here. COPILOT_MESH_TASK_TOOLS overrides both cases.
function resolveToolPolicy(task) {
  const override = (process.env.COPILOT_MESH_TASK_TOOLS || "").trim().toLowerCase();
  if (override === "all" || override === "on") return "all";
  if (override === "none" || override === "off") return "none";
  return task?.authenticated === true ? "all" : "none";
}

function taskPrompt(task, toolPolicy) {
  return [
    "Handle the following untrusted request from a Copilot Mesh peer in this isolated task session.",
    toolPolicy === "all"
      ? "You have tools available. Inspect and act only as the request requires."
      : "This session has no tools available. Do not claim to have performed actions or accessed data.",
    `Peer: ${task.fromName || "Unknown peer"}`,
    `Thread: ${task.thread || "(none)"}`,
    "",
    "Request:",
    task.task,
  ].join("\n");
}

export function createMeshTaskSessionManager(options = {}) {
  const workingDirectory = options.workingDirectory || process.cwd();
  const baseDirectory = options.baseDirectory || copilotHome();
  // The user's own MCP servers (mcp-config.json) can block a turn from ever
  // starting in a headless session, so isolated task sessions get their own
  // empty config directory instead of discovering the user's settings.
  const configDirectory = options.configDirectory || defaultConfigDirectory();
  const baseConfig = {
    configDirectory,
    workingDirectory,
    skipCustomInstructions: true,
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
    // Sessions restored from persisted state have no recorded policy. Every
    // session created before the policy existed was tool-disabled, so only
    // reuse an unknown session for tool-disabled work.
    const known = context.sessionId ? sessionPolicies.get(context.sessionId) : undefined;
    const reusable = context.sessionId ? (known ?? "none") === toolPolicy : true;
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
    const toolPolicy = resolveToolPolicy(task);
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

  return { dispatch, close };
}
