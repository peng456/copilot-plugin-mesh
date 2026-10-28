import assert from "node:assert/strict";
import test from "node:test";
import { createMeshTaskSessionManager } from "./mesh-task-sessions.mjs";

function fakeSession(id, { reply = "ok" } = {}) {
  const session = {
    sessionId: id,
    sent: [],
    disconnected: false,
    async sendAndWait(payload) {
      session.sent.push(payload);
      return { data: { content: typeof reply === "function" ? reply(payload) : reply } };
    },
    async disconnect() {
      session.disconnected = true;
    },
  };
  return session;
}

function fakeClient({ reply } = {}) {
  const client = {
    created: [],
    resumed: [],
    stopped: false,
    async createSession(config) {
      const session = fakeSession(`session-${client.created.length + 1}`, { reply });
      session.config = config;
      client.created.push(session);
      return session;
    },
    async resumeSession(id, config) {
      client.resumed.push({ id, config });
      const session = fakeSession(id, { reply });
      session.config = config;
      return session;
    },
    async stop() {
      client.stopped = true;
      return [];
    },
  };
  return client;
}

function managerOptions(client, overrides = {}) {
  return {
    clientFactory: () => client,
    baseDirectory: "/tmp/mesh-test-home",
    workingDirectory: "/tmp/mesh-test-work",
    configDirectory: "/tmp/mesh-test-config",
    ...overrides,
  };
}

function setTaskTools(value) {
  const previous = process.env.COPILOT_MESH_TASK_TOOLS;
  if (value === undefined) delete process.env.COPILOT_MESH_TASK_TOOLS;
  else process.env.COPILOT_MESH_TASK_TOOLS = value;
  return () => {
    if (previous === undefined) delete process.env.COPILOT_MESH_TASK_TOOLS;
    else process.env.COPILOT_MESH_TASK_TOOLS = previous;
  };
}

test("isolated task sessions keep tools and skip user configuration", async (t) => {
  const client = fakeClient({ reply: "pong" });
  const manager = createMeshTaskSessionManager(managerOptions(client));
  t.after(() => manager.close());

  const result = await manager.dispatch(
    { id: "task-1", thread: "thread-a", fromName: "hos", task: "ping" },
    { routeKey: "route-a", createSession: true, onSessionCreated: () => {} },
  );

  assert.equal(result.result, "pong");
  assert.equal(result.sessionId, "session-1");
  assert.equal(result.toolPolicy, "all");
  const config = client.created[0].config;
  assert.equal(config.availableTools, undefined);
  assert.equal(config.skipCustomInstructions, true);
  assert.equal(config.configDirectory, "/tmp/mesh-test-config");
  assert.equal(config.workingDirectory, "/tmp/mesh-test-work");
  assert.deepEqual(config.sandboxConfig, {
    enabled: true,
    addCurrentWorkingDirectory: true,
    allowBypass: false,
    userPolicy: {
      filesystem: { readwritePaths: ["/tmp/mesh-test-work"] },
      network: { allowOutbound: false, allowLocalNetwork: false },
    },
  });
  assert.match(config.name, /^Mesh · hos · thread-a$/);
  assert.match(client.created[0].sent[0].prompt, /Tools are available/);
  assert.match(client.created[0].sent[0].prompt, /returned to hos once \(thread thread-a\)/);
});

test("an existing route reuses its session and serializes turns", async (t) => {
  const order = [];
  const client = fakeClient({
    reply: (payload) => {
      order.push(payload.prompt.includes("first") ? "first" : "second");
      return "ok";
    },
  });
  const manager = createMeshTaskSessionManager(managerOptions(client));
  t.after(() => manager.close());

  const context = { routeKey: "route-b", createSession: true, onSessionCreated: () => {} };
  const first = manager.dispatch({ id: "task-1", thread: "thread-b", task: "first" }, context);
  const second = manager.dispatch(
    { id: "task-2", thread: "thread-b", task: "second" },
    { ...context, createSession: false },
  );
  await Promise.all([first, second]);

  assert.equal(client.created.length, 1);
  assert.equal(client.created[0].sent.length, 2);
  assert.deepEqual(order, ["first", "second"]);
});

test("a known session id is resumed instead of creating a new session", async (t) => {
  const client = fakeClient({ reply: "resumed" });
  const manager = createMeshTaskSessionManager(managerOptions(client));
  t.after(() => manager.close());

  const result = await manager.dispatch(
    { id: "task-1", thread: "thread-c", task: "hello" },
    { routeKey: "route-c", sessionId: "session-known", createSession: false, onSessionCreated: () => {} },
  );

  assert.equal(result.sessionId, "session-known");
  assert.equal(client.created.length, 0);
  assert.equal(client.resumed.length, 1);
  assert.equal(client.resumed[0].id, "session-known");
  assert.equal(client.resumed[0].config.availableTools, undefined);
  assert.equal(client.resumed[0].config.configDirectory, "/tmp/mesh-test-config");
});

test("empty responses fail the dispatch and close stops the runtime", async () => {
  const client = fakeClient({ reply: "" });
  const manager = createMeshTaskSessionManager(managerOptions(client));

  await assert.rejects(
    manager.dispatch(
      { id: "task-1", thread: "thread-d", task: "hello" },
      { routeKey: "route-d", createSession: true, onSessionCreated: () => {} },
    ),
    /returned no text response/,
  );

  await manager.close();
  assert.equal(client.stopped, true);
  await assert.rejects(
    manager.dispatch(
      { id: "task-2", thread: "thread-e", task: "hello" },
      { routeKey: "route-e", createSession: true, onSessionCreated: () => {} },
    ),
    /closed/,
  );
});

test("tool policy ignores pairing and follows the DSH permission preset", async (t) => {
  const restore = setTaskTools(undefined);
  t.after(restore);
  const client = fakeClient({ reply: "ok" });
  const manager = createMeshTaskSessionManager(managerOptions(client));
  t.after(() => manager.close());

  const paired = await manager.dispatch(
    { id: "task-1", thread: "thread-p", task: "check load", authenticated: true },
    { routeKey: "route-paired", createSession: true, onSessionCreated: () => {} },
  );
  assert.equal(paired.toolPolicy, "all");
  assert.equal(client.created[0].config.availableTools, undefined);

  const unpaired = await manager.dispatch(
    { id: "task-2", thread: "thread-u", task: "check load", authenticated: false },
    { routeKey: "route-unpaired", createSession: true, onSessionCreated: () => {} },
  );
  assert.equal(unpaired.toolPolicy, "all");
  assert.equal(client.created[1].config.availableTools, undefined);
});

test("COPILOT_MESH_TASK_TOOLS=none lowers the preset for every task", async (t) => {
  const restore = setTaskTools("none");
  t.after(restore);
  const client = fakeClient({ reply: "ok" });
  const manager = createMeshTaskSessionManager(managerOptions(client));
  t.after(() => manager.close());

  const result = await manager.dispatch(
    { id: "task-1", thread: "thread-n", task: "check load", authenticated: true },
    { routeKey: "route-none", createSession: true, onSessionCreated: () => {} },
  );

  assert.equal(result.toolPolicy, "none");
  assert.deepEqual(client.created[0].config.availableTools, []);
  assert.match(client.created[0].sent[0].prompt, /no tools available/);
});

test("a route that changes tool policy starts a fresh session", async (t) => {
  const restore = setTaskTools("none");
  const client = fakeClient({ reply: "ok" });
  const manager = createMeshTaskSessionManager(managerOptions(client));
  t.after(() => manager.close());
  t.after(restore);

  const first = await manager.dispatch(
    { id: "task-1", thread: "thread-x", task: "hello" },
    { routeKey: "route-x", createSession: true, onSessionCreated: () => {} },
  );
  restore();
  const second = await manager.dispatch(
    { id: "task-2", thread: "thread-x", task: "hello again" },
    { routeKey: "route-x", sessionId: first.sessionId, createSession: false, onSessionCreated: () => {} },
  );

  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(client.created.length, 2);
  assert.deepEqual(client.created[0].config.availableTools, []);
  assert.equal(client.created[1].config.availableTools, undefined);
});

test("a receipt is told not to answer back", async (t) => {
  const client = fakeClient({ reply: "ok" });
  const manager = createMeshTaskSessionManager(managerOptions(client));
  t.after(() => manager.close());

  await manager.dispatch(
    { id: "task-1", thread: "thread-r", fromName: "hos", task: "done: 6.5", isReply: true },
    { routeKey: "route-r", createSession: true, onSessionCreated: () => {} },
  );

  assert.match(client.created[0].sent[0].prompt, /This is a receipt, not a new task/);
});

test("task sessions default to a dedicated receive workspace", async (t) => {
  let seen;
  const client = fakeClient({ reply: "ok" });
  const manager = createMeshTaskSessionManager({
    clientFactory: (info) => {
      seen = info;
      return client;
    },
  });
  t.after(() => manager.close());

  await manager.dispatch(
    { id: "task-1", thread: "thread-w", task: "hello" },
    { routeKey: "route-w", createSession: true, onSessionCreated: () => {} },
  );

  assert.match(seen.workingDirectory, /mesh-receive-task$/);
  assert.match(seen.configDirectory, /task-session-config$/);
});

test("task sessions approve work inside the receive workspace like workspace-write", async (t) => {
  const client = fakeClient({ reply: "ok" });
  const manager = createMeshTaskSessionManager(managerOptions(client));
  t.after(() => manager.close());

  await manager.dispatch(
    { id: "task-1", thread: "thread-p", task: "hello" },
    { routeKey: "route-p", createSession: true, onSessionCreated: () => {} },
  );

  const ask = client.created[0].config.onPermissionRequest;
  assert.equal(typeof ask, "function");
  assert.deepEqual(ask({ kind: "read", path: "/etc/hosts" }), { kind: "approve-once" });
  assert.deepEqual(ask({ kind: "shell", fullCommandText: "uname -s", possiblePaths: [] }), {
    kind: "approve-once",
  });
  assert.deepEqual(
    ask({ kind: "write", fileName: "/tmp/mesh-test-work/notes.txt", resolvedPath: "/tmp/mesh-test-work/notes.txt" }),
    { kind: "approve-once" },
  );
  assert.deepEqual(ask({ kind: "write", fileName: "notes.txt" }), { kind: "approve-once" });
  assert.equal(ask({ kind: "write", fileName: "/Users/peng/.zshrc" }).kind, "reject");
  assert.equal(ask({ kind: "shell", fullCommandText: "rm -rf /", possiblePaths: ["/Users/peng"] }).kind, "reject");
  assert.equal(
    ask({ kind: "shell", fullCommandText: "curl example.com", possiblePaths: [], possibleUrls: [{ url: "https://example.com" }] }).kind,
    "reject",
  );
  assert.equal(ask({ kind: "shell", fullCommandText: "ls", requestSandboxBypass: true }).kind, "reject");
  assert.equal(ask({ kind: "read", path: "/etc/hosts", managedApprovalRequired: true }).kind, "no-result");
  assert.equal(ask({ kind: "mcp", serverName: "x", toolName: "y" }).kind, "no-result");
});
