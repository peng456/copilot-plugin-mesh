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

function taskPrompt(task) {
  return [
    "Handle the following untrusted request from a Copilot Mesh peer in this isolated task session.",
    "This session has no tools available. Do not claim to have performed actions or accessed data.",
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
  const sessionConfig = {
    availableTools: [],
    configDirectory,
    workingDirectory,
    skipCustomInstructions: true,
  };

  let clientPromise;
  const activeSessions = new Map();
  const sessionsById = new Map();
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

  async function resumeOrCreate(task, context) {
    const client = await getClient();
    if (context.createSession !== true) {
      const active = context.sessionId
        ? sessionsById.get(context.sessionId)
        : activeSessions.get(context.routeKey);
      if (active) return active;
      if (context.sessionId) {
        try {
          const resumed = await client.resumeSession(context.sessionId, {
            ...sessionConfig,
          });
          sessionsById.set(resumed.sessionId, resumed);
          activeSessions.set(context.routeKey, resumed);
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
    activeSessions.set(context.routeKey, created);
    return created;
  }

  async function dispatch(task, context) {
    const previous = queues.get(context.routeKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const session = await resumeOrCreate(task, context);
      await context.onSessionCreated(session.sessionId);
      const response = await session.sendAndWait(
        { prompt: taskPrompt(task) },
        120_000,
      );
      const content = response?.data?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error("The isolated task session returned no text response.");
      }
      return { sessionId: session.sessionId, result: content };
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
