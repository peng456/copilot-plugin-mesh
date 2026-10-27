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

test("paired local peers receive DSH-default and explicit noWake task requests for review", async (t) => {
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
  assert.equal(noWakeTask.status, "awaiting-review");
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

test("mesh endpoints reject public peer addresses and deduplicate task IDs", async (t) => {
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

  const postTask = () => fetch(`http://127.0.0.1:${port}/mesh/v1/task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Dsh-Mesh-Token": local.token,
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
