import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createMeshRuntime } from "./mesh-runtime.mjs";

test("paired local peers can exchange review-only task requests", async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), "copilot-mesh-test-"));
  const sender = createMeshRuntime({ copilotHome: resolve(home, "sender"), port: 0, host: "127.0.0.1" });
  const receiver = createMeshRuntime({ copilotHome: resolve(home, "receiver"), port: 0, host: "127.0.0.1" });
  t.after(async () => {
    await sender.close();
    await receiver.close();
    await rm(home, { recursive: true, force: true });
  });

  await sender.initialize();
  await receiver.initialize();
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

  const inbox = receiver.localState().inbox;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].status, "awaiting-review");
  assert.equal(inbox[0].task, "Review this request before doing anything.");

  const authenticatedTasks = await fetch(`http://127.0.0.1:${receiverPort}/mesh/v1/tasks`, {
    headers: { "X-Plugin-Mesh-Token": receiverState.token },
  });
  assert.equal(authenticatedTasks.status, 200);
  assert.equal((await authenticatedTasks.json()).inbox.length, 1);

  const unauthenticatedTasks = await fetch(`http://127.0.0.1:${receiverPort}/mesh/v1/tasks`);
  assert.equal(unauthenticatedTasks.status, 403);
});

test("mesh endpoints reject public peer addresses and deduplicate task IDs", async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), "copilot-mesh-test-"));
  const runtime = createMeshRuntime({ copilotHome: home, port: 0, host: "127.0.0.1" });
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
      "X-Plugin-Mesh-Token": local.token,
    },
    body: JSON.stringify({ id: "repeatable-test-id", fromName: "Peer", task: "Do not execute automatically." }),
  });
  const first = await postTask();
  const duplicate = await postTask();
  assert.equal(first.status, 202);
  assert.equal(duplicate.status, 202);
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
    headers: { "X-Plugin-Mesh-Token": "incorrect" },
  });
  assert.equal(invalidToken.status, 403);

  const invalidJson = await fetch(`http://127.0.0.1:${port}/mesh/v1/task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Plugin-Mesh-Token": local.token,
    },
    body: "{invalid",
  });
  assert.equal(invalidJson.status, 400);

  const oversizedTask = await fetch(`http://127.0.0.1:${port}/mesh/v1/task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Plugin-Mesh-Token": local.token,
    },
    body: JSON.stringify({ task: "x".repeat(65 * 1024) }),
  });
  assert.equal(oversizedTask.status, 413);
});
