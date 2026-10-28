import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createMeshRuntime } from "./mesh-runtime.mjs";

test("mesh runtime does not silently switch ports when the requested port is unavailable", async (t) => {
  const blocker = createServer();
  await new Promise((resolveListen) => blocker.listen(0, "0.0.0.0", resolveListen));
  const port = blocker.address().port;
  const home = await mkdtemp(resolve(tmpdir(), "copilot-mesh-test-"));
  const runtime = createMeshRuntime({ copilotHome: home, port, host: "0.0.0.0", discovery: false });
  t.after(async () => {
    await runtime.close();
    await new Promise((resolveClose) => blocker.close(resolveClose));
    await rm(home, { recursive: true, force: true });
  });

  await runtime.initialize();
  await assert.rejects(runtime.listen(), { code: "EADDRINUSE" });
  assert.equal(runtime.port, null);
});

test("paired local peers receive normal and noWake tasks according to inbound policy", async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), "copilot-mesh-test-"));
  const sender = createMeshRuntime({ copilotHome: resolve(home, "sender"), port: 0, host: "127.0.0.1", discovery: false });
  const receiver = createMeshRuntime({ copilotHome: resolve(home, "receiver"), port: 0, host: "127.0.0.1", discovery: false });
  t.after(async () => {
    await sender.close();
    await receiver.close();
    await rm(home, { recursive: true, force: true });
  });

  await sender.initialize();
  await receiver.initialize();
  sender.state.token = "b".repeat(32);
  await sender.persist();
  receiver.state.token = "a".repeat(32);
  await receiver.persist();
  const senderPort = await sender.listen();
  const receiverPort = await receiver.listen();
  const senderState = sender.localState({ includeToken: true });
  const receiverState = receiver.localState({ includeToken: true });
  const peer = await sender.addPeer({
    name: "Receiver test node",
    url: `http://127.0.0.1:${receiverPort}`,
    token: receiverState.token,
  });
  await receiver.addPeer({
    name: "Sender test node",
    url: `http://127.0.0.1:${senderPort}`,
    token: senderState.token,
  });

  const sent = await sender.sendTask({ peerId: peer.id, task: "Review this request before doing anything." });
  assert.equal(sent.accepted, true);
  assert.equal(sent.status, "accepted-for-review");
  assert.equal(sent.noWake, false);

  const noWakeSent = await sender.sendTask({
    peerId: peer.id,
    task: "Keep this status notice in the inbox only.",
    noWake: true,
  });
  assert.equal(noWakeSent.accepted, true);
  assert.equal(noWakeSent.noWake, true);

  const inbox = receiver.localState().inbox;
  assert.equal(inbox.length, 2);
  const normalTask = inbox.find((item) => item.task === "Review this request before doing anything.");
  const noWakeTask = inbox.find((item) => item.task === "Keep this status notice in the inbox only.");
  assert.equal(normalTask.status, "awaiting-review");
  assert.equal(normalTask.noWake, false);
  assert.equal(noWakeTask.status, "noted-only");
  assert.equal(noWakeTask.noWake, true);

  const authenticatedTasks = await fetch(`http://127.0.0.1:${receiverPort}/mesh/v1/tasks`, {
    headers: { "X-Dsh-Mesh-Token": receiverState.token },
  });
  assert.equal(authenticatedTasks.status, 200);
  assert.equal((await authenticatedTasks.json()).inbox.length, 2);
  const peerTokenTasks = await fetch(`http://127.0.0.1:${receiverPort}/mesh/v1/tasks`, {
    headers: { "X-Dsh-Mesh-Token": senderState.token },
  });
  assert.equal(peerTokenTasks.status, 200);

  const unauthenticatedTasks = await fetch(`http://127.0.0.1:${receiverPort}/mesh/v1/tasks`);
  assert.equal(unauthenticatedTasks.status, 403);
  assert.equal(receiverState.token.length, 32);
});

test("normal inbound tasks use isolated sessions with DSH filtering and thread limits", async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), "copilot-mesh-test-"));
  const dispatches = [];
  let now = 10_000;
  const runtime = createMeshRuntime({
    copilotHome: home,
    port: 0,
    host: "127.0.0.1",
    discovery: false,
    now: () => now,
    taskDispatcher: async (task, context) => {
      dispatches.push({ id: task.id, ...context });
      const sessionId = context.sessionId || `session-${task.thread || "default"}`;
      await context.onSessionCreated(sessionId);
      return { sessionId, result: `Handled: ${task.task}` };
    },
  });
  t.after(async () => {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  });

  await runtime.initialize();
  const port = await runtime.listen();
  const send = async ({ id, task, thread = "topic", noWake = false, newSession = false }) => {
    const response = await fetch(`http://127.0.0.1:${port}/mesh/v1/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, task, thread, noWake, newSession }),
    });
    return response.json();
  };
  const waitForStatus = async (id, status) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const task = runtime.localState().inbox.find((entry) => entry.id === id);
      if (task?.status === status) return task;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.fail(`Task ${id} did not reach status ${status}.`);
  };

  const first = await send({ id: "route-first", task: "Please summarize this request." });
  assert.equal(first.status, "dispatching");
  const firstTask = await waitForStatus("route-first", "completed");
  assert.equal(firstTask.result, "Handled: Please summarize this request.");
  assert.equal(dispatches[0].createSession, true);

  const second = await send({ id: "route-second", task: "Continue the same topic." });
  assert.equal(second.status, "dispatching");
  const secondTask = await waitForStatus("route-second", "completed");
  assert.equal(secondTask.sessionId, firstTask.sessionId);
  assert.equal(dispatches[1].createSession, false);

  assert.equal((await send({ id: "route-no-wake", task: "Keep this notice only.", noWake: true })).status, "noted-only");
  assert.equal((await send({ id: "route-short", task: "Thanks!" })).status, "noted-only");
  assert.equal((await send({ id: "route-greeting", task: "你好" })).status, "noted-only");
  assert.equal((await send({ id: "route-cooldown", task: "Start a new session now.", newSession: true })).status, "rate-limited");

  for (let index = 0; index < 28; index += 1) {
    await send({ id: `route-limit-${index}`, task: `Continue the request with step ${index}.` });
  }
  const limited = await send({ id: "route-limit-31", task: "This exceeds the hourly thread limit." });
  assert.equal(limited.status, "rate-limited");
  assert.equal(dispatches.length, 30);

  now += 60 * 60_000;
  assert.equal((await send({ id: "route-window-reset", task: "This is allowed in the next window." })).status, "dispatching");
});

test("private task submissions do not require pairing, but control endpoints remain protected", async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), "copilot-mesh-test-"));
  const runtime = createMeshRuntime({ copilotHome: home, port: 0, host: "127.0.0.1", discovery: false });
  t.after(async () => {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  });

  await runtime.initialize();
  const port = await runtime.listen();
  const local = runtime.localState({ includeToken: true });
  await assert.rejects(
    runtime.addPeer({ name: "Public target", url: "http://203.0.113.8:45917", token: local.token }),
    /private, loopback, or link-local IP/,
  );

  const postTask = (token) => fetch(`http://127.0.0.1:${port}/mesh/v1/task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Dsh-Mesh-Token": token } : {}),
    },
    body: JSON.stringify({ id: "repeatable-test-id", fromName: "Peer", task: "Do not execute automatically." }),
  });
  const first = await postTask();
  const duplicate = await postTask();
  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 200);
  assert.equal((await first.json()).duplicate, false);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(runtime.localState().inbox.length, 1);
  assert.equal(runtime.localState().inbox[0].status, "awaiting-review");
  await runtime.dismissTask("repeatable-test-id");
  assert.equal(runtime.localState().inbox[0].status, "dismissed");

  const stateFile = resolve(home, "extensions", "plugin-mesh", "artifacts", "mesh-state.json");
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(persisted.inbox[0].status, "dismissed");

  const invalidToken = await fetch(`http://127.0.0.1:${port}/mesh/v1/tasks`, {
    headers: { "X-Dsh-Mesh-Token": "incorrect" },
  });
  assert.equal(invalidToken.status, 403);
  const unauthenticatedRead = await fetch(`http://127.0.0.1:${port}/mesh/v1/tasks`);
  assert.equal(unauthenticatedRead.status, 403);

  const invalidJson = await fetch(`http://127.0.0.1:${port}/mesh/v1/task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Dsh-Mesh-Token": local.token,
    },
    body: "{invalid",
  });
  assert.equal(invalidJson.status, 400);

  const oversizedTask = await fetch(`http://127.0.0.1:${port}/mesh/v1/task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Dsh-Mesh-Token": local.token,
    },
    body: JSON.stringify({ task: "x".repeat(257 * 1024) }),
  });
  assert.equal(oversizedTask.status, 413);
});

test("identity and discovery cards use the DSH mesh v2 wire shape", async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), "copilot-mesh-test-"));
  const runtime = createMeshRuntime({ copilotHome: home, port: 0, host: "127.0.0.1", discovery: false });
  t.after(async () => {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  });

  await runtime.initialize();
  await runtime.listen();
  const record = runtime.selfRecord();
  assert.equal(record.app, "dsh-mesh");
  assert.equal(record.v, 2);
  assert.match(record.id, /^[a-f0-9]{16}$/);
  assert.equal(Object.hasOwn(record, "mac"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) < 1400);

  const originalId = record.id;
  const restarted = createMeshRuntime({ copilotHome: home, port: 0, host: "127.0.0.1", discovery: false });
  t.after(() => restarted.close());
  await restarted.initialize();
  assert.equal(restarted.selfRecord().id, originalId);

  await assert.rejects(runtime.setName("bad/name"), /Machine name/);
  assert.equal((await runtime.setName("Studio Mac")).name, "Studio Mac");
});

test("state files written before DSH routing load and upgrade in place", async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), "copilot-mesh-test-"));
  const storageFile = resolve(home, "extensions", "plugin-mesh", "artifacts", "mesh-state.json");
  const legacy = {
    version: 1,
    nodeId: "a1b2c3d4e5f60718",
    instanceId: "a1b2c3d4e5f60718",
    name: "Legacy node",
    token: "A".repeat(43),
    peers: [],
    discovered: [],
    inbox: [{
      id: "t-legacy",
      status: "awaiting-review",
      task: "an older task kept for review",
      fromName: "hos",
      receivedAt: "2026-01-01T00:00:00.000Z",
    }],
    sent: [],
  };
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(resolve(storageFile, ".."), { recursive: true });
  await writeFile(storageFile, JSON.stringify(legacy));

  const runtime = createMeshRuntime({ copilotHome: home, port: 0, host: "127.0.0.1", discovery: false });
  t.after(async () => {
    await runtime.close();
    await rm(home, { recursive: true, force: true });
  });

  await runtime.initialize();
  const state = runtime.localState();
  assert.equal(state.nodeId, "a1b2c3d4e5f60718");
  assert.equal(state.name, "Legacy node");
  assert.equal(state.inbox.length, 1);
  assert.equal(state.inbox[0].status, "awaiting-review");

  await runtime.listen();
  await runtime.persist();
  const upgraded = JSON.parse(await readFile(storageFile, "utf8"));
  assert.deepEqual(upgraded.routeSessions, []);
  assert.deepEqual(upgraded.threadActivity, []);
  assert.equal(upgraded.token, "A".repeat(43));
  assert.equal(upgraded.inbox[0].id, "t-legacy");
});

test("discovered peers stay online between full LAN scans", async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), "copilot-mesh-test-"));
  const remote = createMeshRuntime({ copilotHome: resolve(home, "remote"), port: 0, host: "127.0.0.1", discovery: false });
  const local = createMeshRuntime({ copilotHome: resolve(home, "local"), port: 0, host: "127.0.0.1", discovery: false });
  t.after(async () => {
    await remote.close();
    await local.close();
    await rm(home, { recursive: true, force: true });
  });

  await remote.initialize();
  await remote.listen();
  await local.initialize();
  await local.listen();

  const remoteRecord = remote.localState();
  local.state.discovered.push({
    nodeId: remoteRecord.nodeId,
    name: "stale name",
    host: "127.0.0.1",
    port: remote.port,
    status: "offline",
    lastSeen: Date.now() - 120_000,
    capabilities: null,
    capabilitiesAt: 0,
    paired: false,
  });

  assert.equal(await local.probeDiscoveredPeer(local.state.discovered[0]), true);
  const [peer] = local.localState().discovered;
  assert.equal(peer.status, "online");
  assert.equal(peer.name, remoteRecord.name);
  assert.ok(Date.now() - peer.lastSeen < 5_000);
  assert.equal(peer.paired, false);

  await remote.close();
  assert.equal(await local.probeDiscoveredPeer(local.state.discovered[0]), false);
});

test("a completed task is delivered back to the sender as a noWake notice", async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), "copilot-mesh-test-"));
  const sender = createMeshRuntime({ copilotHome: resolve(home, "sender"), port: 0, host: "127.0.0.1", discovery: false });
  const receiver = createMeshRuntime({
    copilotHome: resolve(home, "receiver"),
    port: 0,
    host: "127.0.0.1",
    discovery: false,
    taskDispatcher: async (task, context) => {
      const sessionId = context.sessionId || "session-reply";
      await context.onSessionCreated(sessionId);
      return { sessionId, result: `Answer for ${task.id}`, toolPolicy: "none" };
    },
  });
  t.after(async () => {
    await sender.close();
    await receiver.close();
    await rm(home, { recursive: true, force: true });
  });

  await sender.initialize();
  await receiver.initialize();
  const senderPort = await sender.listen();
  const receiverPort = await receiver.listen();

  const response = await fetch(`http://127.0.0.1:${receiverPort}/mesh/v1/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "reply-1",
      task: "How is the machine doing right now?",
      thread: "reply-thread",
      fromMachine: "sender-node",
      fromPort: senderPort,
    }),
  });
  assert.equal((await response.json()).status, "dispatching");

  let task;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    task = receiver.localState().inbox.find((entry) => entry.id === "reply-1");
    if (task?.status === "completed" && task.replyStatus) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.equal(task.status, "completed");
  assert.equal(task.replyStatus, "delivered");

  const delivered = sender.localState().inbox.find((entry) => entry.id === "reply-1:reply");
  assert.ok(delivered, "sender should receive the answer");
  assert.equal(delivered.task, "Answer for reply-1");
  assert.equal(delivered.status, "noted-only");
  assert.equal(delivered.noWake, true);
  assert.equal(delivered.fromMachine, receiver.localState().name);
});

test("a reply without a routable sender is recorded but not sent", async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), "copilot-mesh-test-"));
  const receiver = createMeshRuntime({
    copilotHome: home,
    port: 0,
    host: "127.0.0.1",
    discovery: false,
    taskDispatcher: async (task, context) => {
      const sessionId = context.sessionId || "session-solo";
      await context.onSessionCreated(sessionId);
      return { sessionId, result: "solo answer" };
    },
  });
  t.after(async () => {
    await receiver.close();
    await rm(home, { recursive: true, force: true });
  });

  await receiver.initialize();
  const port = await receiver.listen();
  await fetch(`http://127.0.0.1:${port}/mesh/v1/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "solo-1", task: "Any answer will do here.", thread: "solo" }),
  });

  let task;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    task = receiver.localState().inbox.find((entry) => entry.id === "solo-1");
    if (task?.status === "completed" && task.replyStatus) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.equal(task.status, "completed");
  assert.equal(task.replyStatus, "no-route");
});

test("an answer to our own outbound task is treated as a receipt and not answered", async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), "copilot-mesh-test-"));
  const sender = createMeshRuntime({ copilotHome: resolve(home, "sender"), port: 0, host: "127.0.0.1", discovery: false });
  const receiver = createMeshRuntime({
    copilotHome: resolve(home, "receiver"),
    port: 0,
    host: "127.0.0.1",
    discovery: false,
    taskDispatcher: async (task, context) => {
      const sessionId = context.sessionId || "session-receipt";
      await context.onSessionCreated(sessionId);
      return { sessionId, result: `Answer for ${task.id}` };
    },
  });
  t.after(async () => {
    await sender.close();
    await receiver.close();
    await rm(home, { recursive: true, force: true });
  });

  await sender.initialize();
  await receiver.initialize();
  const senderPort = await sender.listen();
  const receiverPort = await receiver.listen();

  // The receiver already dispatched a task to this machine on this thread, so
  // the same thread coming back is the answer, not a new request.
  receiver.state.sent.push({ id: "t-out", peerName: "sender-node", thread: "loop-thread", noWake: false });

  await fetch(`http://127.0.0.1:${receiverPort}/mesh/v1/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "loop-1",
      task: "Here is the answer to the question you asked me.",
      thread: "loop-thread",
      fromMachine: "sender-node",
      fromPort: senderPort,
    }),
  });

  let task;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    task = receiver.state.inbox.find((entry) => entry.id === "loop-1");
    if (task?.status === "completed" && task.replyStatus) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.equal(task.isReply, true);
  assert.equal(task.replyStatus, "skipped-reply");
  assert.equal(
    sender.localState().inbox.find((entry) => entry.id === "loop-1:reply"),
    undefined,
    "a receipt must not be answered again",
  );
});
