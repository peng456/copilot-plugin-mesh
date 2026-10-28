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

test("isolated task sessions disable tools and skip user configuration", async (t) => {
  const client = fakeClient({ reply: "pong" });
  const manager = createMeshTaskSessionManager(managerOptions(client));
  t.after(() => manager.close());

  const result = await manager.dispatch(
    { id: "task-1", thread: "thread-a", fromName: "hos", task: "ping" },
    { routeKey: "route-a", createSession: true, onSessionCreated: () => {} },
  );

  assert.equal(result.result, "pong");
  assert.equal(result.sessionId, "session-1");
  const config = client.created[0].config;
  assert.deepEqual(config.availableTools, []);
  assert.equal(config.skipCustomInstructions, true);
  assert.equal(config.configDirectory, "/tmp/mesh-test-config");
  assert.equal(config.workingDirectory, "/tmp/mesh-test-work");
  assert.match(config.name, /^Mesh · hos · thread-a$/);
  assert.match(client.created[0].sent[0].prompt, /no tools available/);
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
  assert.deepEqual(client.resumed[0].config.availableTools, []);
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
