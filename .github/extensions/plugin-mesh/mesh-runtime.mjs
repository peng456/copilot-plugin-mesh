import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname, networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { isIP } from "node:net";

const API_PREFIX = "/mesh/v1";
const MAX_TASK_LENGTH = 64 * 1024;
const MAX_REQUEST_LENGTH = MAX_TASK_LENGTH + 4096;
const MAX_HISTORY = 100;

function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || a === 127
      || (a === 169 && b === 254);
  }
  if (version === 6) {
    const normalized = address.toLowerCase().split("%")[0];
    return normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe80:");
  }
  return false;
}

function normalizePeerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Peer URL must be a valid HTTP URL using a private IP address.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !isPrivateAddress(host)) {
    throw new Error("Peer URL must use plain HTTP on a private, loopback, or link-local IP address.");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Peer URL must contain only the scheme, IP address, and optional port.");
  }
  return url.origin;
}

function isValidToken(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  const supplied = Buffer.from(candidate);
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function safePeer(peer) {
  return {
    id: peer.id,
    name: peer.name,
    url: peer.url,
    nodeId: peer.nodeId ?? null,
    status: peer.status ?? "unknown",
    lastSeen: peer.lastSeen ?? null,
  };
}

function localAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && isPrivateAddress(entry.address)) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

export class MeshRuntime {
  constructor({ storageFile, port = 45917, host = "0.0.0.0" }) {
    this.storageFile = storageFile;
    this.requestedPort = port;
    this.host = host;
    this.state = null;
    this.server = null;
    this.port = null;
    this.persistQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.storageFile), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.storageFile), 0o700);
    try {
      const saved = JSON.parse(await readFile(this.storageFile, "utf8"));
      if (saved.version !== 1 || !Array.isArray(saved.peers) || !Array.isArray(saved.inbox) || !Array.isArray(saved.sent)) {
        throw new Error("Unsupported or invalid mesh state file.");
      }
      this.state = {
        version: 1,
        nodeId: saved.nodeId,
        name: saved.name,
        token: saved.token,
        peers: saved.peers,
        inbox: saved.inbox.slice(-MAX_HISTORY),
        sent: saved.sent.slice(-MAX_HISTORY),
      };
      if (!/^[a-f0-9]{32}$/.test(this.state.nodeId) || typeof this.state.token !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(this.state.token)) {
        throw new Error("Mesh state is missing a valid node identity or pairing token.");
      }
      if (typeof this.state.name !== "string" || this.state.name.length < 1 || this.state.name.length > 64) {
        throw new Error("Mesh state contains an invalid node name.");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = {
        version: 1,
        nodeId: randomBytes(16).toString("hex"),
        name: hostname().slice(0, 64) || "Copilot node",
        token: randomBytes(32).toString("base64url"),
        peers: [],
        inbox: [],
        sent: [],
      };
      await this.persist();
    }
    await chmod(this.storageFile, 0o600);
  }

  persist() {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    const operation = this.persistQueue.catch(() => {}).then(async () => {
      const temporaryFile = `${this.storageFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporaryFile, snapshot, { mode: 0o600 });
      await chmod(temporaryFile, 0o600);
      await rename(temporaryFile, this.storageFile);
      await chmod(this.storageFile, 0o600);
    });
    this.persistQueue = operation;
    return operation;
  }

  async listen() {
    if (!this.state) throw new Error("Initialize the mesh runtime before listening.");
    this.server = createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        if (!response.headersSent) this.sendJson(response, 500, { ok: false, error: "Internal mesh error." });
        else response.destroy(error);
      });
    });
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.maxHeadersCount = 32;

    try {
      await new Promise((resolveListen, rejectListen) => {
        this.server.once("error", rejectListen);
        this.server.listen(this.requestedPort, this.host, resolveListen);
      });
    } catch (error) {
      if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
      await new Promise((resolveListen, rejectListen) => {
        this.server.removeAllListeners("error");
        this.server.once("error", rejectListen);
        this.server.listen(0, this.host, resolveListen);
      });
    }
    this.port = this.server.address().port;
    return this.port;
  }

  close() {
    if (!this.server?.listening) return Promise.resolve();
    return new Promise((resolveClose, rejectClose) => {
      this.server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }

  sendJson(response, status, value) {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(value));
  }

  async readBody(request) {
    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (declaredLength > MAX_REQUEST_LENGTH) throw new Error("Request body exceeds the size limit.");
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > MAX_REQUEST_LENGTH) throw new Error("Request body exceeds the size limit.");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      throw new Error("Request body must be valid JSON.");
    }
  }

  async handleRequest(request, response) {
    const url = new URL(request.url, "http://mesh.local");
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/health`) {
      this.sendJson(response, 200, {
        ok: true,
        app: "copilot-plugin-mesh",
        version: 1,
        nodeId: this.state.nodeId,
        name: this.state.name,
        port: this.port,
      });
      return;
    }

    if (!url.pathname.startsWith(`${API_PREFIX}/`) && url.pathname !== API_PREFIX) {
      this.sendJson(response, 404, { ok: false, error: "Not found." });
      return;
    }
    if (!isValidToken(request.headers["x-plugin-mesh-token"], this.state.token)) {
      this.sendJson(response, 403, { ok: false, error: "Pairing token is missing or invalid." });
      return;
    }

    if (request.method === "GET" && url.pathname === `${API_PREFIX}/hello`) {
      this.sendJson(response, 200, {
        ok: true,
        nodeId: this.state.nodeId,
        name: this.state.name,
        paired: true,
        app: "copilot-plugin-mesh",
        version: 1,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/peers`) {
      this.sendJson(response, 200, { ok: true, peers: this.state.peers.map(safePeer) });
      return;
    }
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/tasks`) {
      this.sendJson(response, 200, {
        ok: true,
        inbox: this.state.inbox.slice(-MAX_HISTORY).reverse(),
        sent: this.state.sent.slice(-MAX_HISTORY).reverse(),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === `${API_PREFIX}/task`) {
      let body;
      try {
        body = await this.readBody(request);
      } catch (error) {
        const status = error.message.includes("size limit") ? 413 : 400;
        this.sendJson(response, status, { ok: false, error: error.message });
        return;
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        this.sendJson(response, 400, { ok: false, error: "Request body must be a JSON object." });
        return;
      }
      if (typeof body.task !== "string" || body.task.trim().length === 0) {
        this.sendJson(response, 400, { ok: false, error: "Task text is required." });
        return;
      }
      if (Buffer.byteLength(body.task, "utf8") > MAX_TASK_LENGTH) {
        this.sendJson(response, 413, { ok: false, error: "Task text exceeds 64 KiB." });
        return;
      }

      const id = typeof body.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(body.id)
        ? body.id
        : randomBytes(12).toString("hex");
      const existing = this.state.inbox.find((item) => item.id === id);
      if (existing) {
        this.sendJson(response, 202, { ok: true, id, duplicate: true, status: existing.status });
        return;
      }

      const task = {
        id,
        fromNodeId: typeof body.fromNodeId === "string" ? body.fromNodeId.slice(0, 64) : "unknown",
        fromName: typeof body.fromName === "string" ? body.fromName.slice(0, 64) : "Unknown peer",
        task: body.task,
        receivedAt: new Date().toISOString(),
        status: "awaiting-review",
      };
      this.state.inbox.push(task);
      this.state.inbox = this.state.inbox.slice(-MAX_HISTORY);
      await this.persist();
      this.sendJson(response, 202, { ok: true, id, duplicate: false, status: task.status });
      return;
    }
    this.sendJson(response, 404, { ok: false, error: "Not found." });
  }

  localState({ includeToken = false } = {}) {
    return {
      nodeId: this.state.nodeId,
      name: this.state.name,
      ...(includeToken ? { token: this.state.token } : {}),
      port: this.port,
      addresses: localAddresses(),
      peers: this.state.peers.map(safePeer),
      inbox: this.state.inbox.slice(-MAX_HISTORY).reverse(),
      sent: this.state.sent.slice(-MAX_HISTORY).reverse(),
    };
  }

  async addPeer({ name, url, token }) {
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 64) {
      throw new Error("Peer name must contain 1–64 characters.");
    }
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(token)) {
      throw new Error("Peer pairing token must be a valid token copied from that peer.");
    }
    const normalizedUrl = normalizePeerUrl(url);
    const response = await fetch(`${normalizedUrl}${API_PREFIX}/hello`, {
      headers: { "X-Plugin-Mesh-Token": token },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      if (response.status === 403) throw new Error("Peer rejected the token. Copy the target peer's pairing token.");
      throw new Error(`Peer handshake failed (${response.status}).`);
    }
    const remote = await response.json();
    if (!remote.ok || typeof remote.nodeId !== "string" || !/^[a-f0-9]{32}$/.test(remote.nodeId)) {
      throw new Error("Peer returned an invalid handshake response.");
    }
    const existing = this.state.peers.find((peer) => peer.nodeId === remote.nodeId || peer.url === normalizedUrl);
    const peer = {
      id: remote.nodeId,
      nodeId: remote.nodeId,
      name: name.trim(),
      url: normalizedUrl,
      token,
      status: "online",
      lastSeen: new Date().toISOString(),
    };
    if (existing) Object.assign(existing, peer);
    else this.state.peers.push(peer);
    await this.persist();
    return safePeer(peer);
  }

  async refreshPeer(id) {
    const peer = this.state.peers.find((item) => item.id === id);
    if (!peer) throw new Error("Peer not found.");
    const response = await fetch(`${peer.url}${API_PREFIX}/hello`, {
      headers: { "X-Plugin-Mesh-Token": peer.token },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      peer.status = response.status === 403 ? "unpaired" : "offline";
      await this.persist();
      throw new Error(response.status === 403 ? "Peer no longer accepts this pairing token." : `Peer is unreachable (${response.status}).`);
    }
    const remote = await response.json();
    if (!remote.ok || remote.nodeId !== peer.nodeId) {
      peer.status = "identity-changed";
      await this.persist();
      throw new Error("Peer identity changed. Remove it and pair the new identity explicitly.");
    }
    peer.name = typeof remote.name === "string" ? remote.name.slice(0, 64) : peer.name;
    peer.status = "online";
    peer.lastSeen = new Date().toISOString();
    await this.persist();
    return safePeer(peer);
  }

  async removePeer(id) {
    const count = this.state.peers.length;
    this.state.peers = this.state.peers.filter((peer) => peer.id !== id);
    if (this.state.peers.length === count) throw new Error("Peer not found.");
    await this.persist();
    return { removed: true, id };
  }

  async sendTask({ peerId, task }) {
    const peer = this.state.peers.find((item) => item.id === peerId);
    if (!peer) throw new Error("Peer not found. Add and pair it first.");
    if (typeof task !== "string" || task.trim().length === 0) throw new Error("Task text is required.");
    if (Buffer.byteLength(task, "utf8") > MAX_TASK_LENGTH) throw new Error("Task text exceeds 64 KiB.");

    const id = `t-${randomBytes(12).toString("hex")}`;
    const record = {
      id,
      peerId: peer.id,
      peerName: peer.name,
      task,
      sentAt: new Date().toISOString(),
      status: "sending",
    };
    this.state.sent.push(record);
    this.state.sent = this.state.sent.slice(-MAX_HISTORY);
    await this.persist();

    try {
      const response = await fetch(`${peer.url}${API_PREFIX}/task`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Plugin-Mesh-Token": peer.token,
        },
        body: JSON.stringify({
          id,
          fromNodeId: this.state.nodeId,
          fromName: this.state.name,
          task,
        }),
        signal: AbortSignal.timeout(8000),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `Peer rejected the task (${response.status}).`);
      record.status = result.duplicate ? "already-received" : "accepted-for-review";
      record.response = result.status;
      peer.status = "online";
      peer.lastSeen = new Date().toISOString();
      await this.persist();
      return {
        accepted: true,
        id,
        status: record.status,
        message: "Delivered to the peer's review inbox; acceptance does not mean the task was executed.",
      };
    } catch (error) {
      record.status = "failed";
      record.error = error.message;
      await this.persist();
      throw new Error(`Task was not confirmed as delivered: ${error.message}`);
    }
  }

  async dismissTask(id) {
    const task = this.state.inbox.find((item) => item.id === id);
    if (!task) throw new Error("Inbox task not found.");
    task.status = "dismissed";
    task.dismissedAt = new Date().toISOString();
    await this.persist();
    return { dismissed: true, id };
  }
}

export function createMeshRuntime({ copilotHome = process.env.COPILOT_HOME || resolve(homedir(), ".copilot"), port, host } = {}) {
  return new MeshRuntime({
    storageFile: resolve(copilotHome, "extensions", "plugin-mesh", "artifacts", "mesh-state.json"),
    ...(port === undefined ? {} : { port }),
    ...(host === undefined ? {} : { host }),
  });
}
