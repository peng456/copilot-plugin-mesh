import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname, networkInterfaces, platform, release, cpus, totalmem } from "node:os";
import { dirname, delimiter, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isIP } from "node:net";
import { createSocket } from "node:dgram";

const API_PREFIX = "/mesh/v1";
const MAX_TASK_LENGTH = 256 * 1024;
const MAX_REQUEST_LENGTH = MAX_TASK_LENGTH + 4096;
const MAX_HISTORY = 200;
const MIN_TASK_CHARS = 8;
const THREAD_COOLDOWN_MS = 5_000;
const THREAD_WINDOW_MS = 60 * 60_000;
const MAX_WAKES_PER_THREAD = 30;
const MULTICAST_GROUP = "239.255.42.99";
const MULTICAST_PORT = 45892;
const DEFAULT_PEER_PORT = 45917;
const PEER_TTL_MS = 20_000;
const PEER_KEEP_MS = 5 * 60_000;
const NOTICE_ONLY_PATTERN = /^(?:hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|ok|okay|got it|understood|你好|您好|嗨|收到|好的|谢谢|感谢|明白了)[\s.!?,，。！？~～]*$/iu;
const execFileAsync = promisify(execFile);

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

function isValidPairingToken(value) {
  return typeof value === "string"
    && value.length >= 16
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
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
      const linkLocalIpv6 = isIP(entry.address) === 6 && entry.address.toLowerCase().startsWith("fe80:");
      if (!entry.internal && !linkLocalIpv6 && isPrivateAddress(entry.address)) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

function sanitizeCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const runtimes = {};
  if (value.runtimes && typeof value.runtimes === "object" && !Array.isArray(value.runtimes)) {
    for (const [name, version] of Object.entries(value.runtimes).slice(0, 20)) {
      if (typeof name === "string" && typeof version === "string") {
        runtimes[name.slice(0, 24)] = version.replace(/[^0-9A-Za-z.+_-]/g, "").slice(0, 24);
      }
    }
  }
  return {
    os: typeof value.os === "string" ? value.os.slice(0, 96) : "",
    arch: typeof value.arch === "string" ? value.arch.slice(0, 32) : "",
    cpuCount: Number.isInteger(value.cpuCount ?? value.cpuCores)
      ? Math.min(Math.max(value.cpuCount ?? value.cpuCores, 0), 1024)
      : null,
    memoryBytes: Number.isFinite(value.memoryBytes)
      ? Math.max(0, Math.min(value.memoryBytes, 2 ** 60))
      : Number.isFinite(value.memMb)
        ? Math.max(0, Math.min(value.memMb, 1024 * 1024)) * 1024 * 1024
        : null,
    runtimes,
    runtimesIncomplete: value.runtimesIncomplete === true,
    probeFailCount: Number.isInteger(value.probeFailCount) ? Math.max(0, value.probeFailCount) : 0,
    capabilitiesAt: Number.isFinite(value.capabilitiesAt) ? value.capabilitiesAt : 0,
  };
}

async function probeCapabilities() {
  const commands = ["node", "python3", "python", "go", "git", "docker", "ffmpeg"];
  const pathEntries = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const runtimes = {};
  const errors = [];
  await Promise.all(commands.map(async (command) => {
    try {
      const { stdout } = await execFileAsync(command, ["--version"], { timeout: 1200, windowsHide: true });
      runtimes[command] = stdout.match(/\d+(?:\.\d+){0,3}/)?.[0] || "unknown";
    } catch (error) {
      if (error.code !== "ENOENT") errors.push(command);
    }
  }));
  const pathHash = createHash("sha256").update(pathEntries.join(delimiter)).digest("hex").slice(0, 16);
  return {
    os: `${platform()} ${release()}`.slice(0, 96),
    arch: process.arch,
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    runtimes,
    runtimesIncomplete: errors.length > 0,
    probeFailCount: errors.length,
    capabilitiesAt: Date.now(),
    pathEntries: pathEntries.slice(0, 64).map((entry) => entry.slice(0, 240)),
    pathHash,
    probeErrors: errors,
  };
}

export class MeshRuntime {
  constructor({
    storageFile,
    port = 45917,
    host = "0.0.0.0",
    discovery = true,
    discoveryGroup = MULTICAST_GROUP,
    discoveryPort = MULTICAST_PORT,
    taskDispatcher,
    now = Date.now,
    onError,
  }) {
    this.storageFile = storageFile;
    this.requestedPort = port;
    this.host = host;
    this.discoveryEnabled = discovery;
    this.discoveryGroup = discoveryGroup;
    this.discoveryPort = discoveryPort;
    this.state = null;
    this.server = null;
    this.port = null;
    this.persistQueue = Promise.resolve();
    this.discoverySocket = null;
    this.discoveryTimers = [];
    this.capabilities = null;
    this.discoveryError = "";
    this.taskDispatcher = taskDispatcher;
    this.now = now;
    this.onError = onError;
    this.backgroundTasks = new Set();
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
        nodeId: typeof saved.instanceId === "string" && /^[a-f0-9]{16}$/.test(saved.instanceId)
          ? saved.instanceId
          : typeof saved.nodeId === "string" && /^[a-f0-9]{32}$/.test(saved.nodeId)
            ? saved.nodeId.slice(0, 16)
            : saved.nodeId,
        instanceId: typeof saved.instanceId === "string" && /^[a-f0-9]{16}$/.test(saved.instanceId)
          ? saved.instanceId
          : typeof saved.nodeId === "string" && /^[a-f0-9]{32}$/.test(saved.nodeId)
            ? saved.nodeId.slice(0, 16)
            : saved.nodeId,
        name: saved.name,
        token: saved.token,
        peers: saved.peers,
        discovered: Array.isArray(saved.discovered) ? saved.discovered.slice(-MAX_HISTORY) : [],
        inbox: saved.inbox.slice(-MAX_HISTORY),
        sent: saved.sent.slice(-MAX_HISTORY),
        routeSessions: Array.isArray(saved.routeSessions)
          ? saved.routeSessions.filter((entry) => entry && typeof entry.key === "string")
            .map((entry) => ({
              key: entry.key,
              sessionId: typeof entry.sessionId === "string" ? entry.sessionId : null,
              createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
              lastUsedAt: Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : 0,
            })).slice(-MAX_HISTORY)
          : [],
        threadActivity: Array.isArray(saved.threadActivity)
          ? saved.threadActivity.filter((entry) => entry && typeof entry.key === "string")
            .map((entry) => ({
              key: entry.key,
              wakeTimes: Array.isArray(entry.wakeTimes)
                ? entry.wakeTimes.filter((timestamp) => Number.isFinite(timestamp)).slice(-MAX_WAKES_PER_THREAD)
                : [],
              lastNewSessionAt: Number.isFinite(entry.lastNewSessionAt) ? entry.lastNewSessionAt : null,
            })).slice(-MAX_HISTORY)
          : [],
      };
      if (!/^[a-f0-9]{16}$/.test(this.state.nodeId) || !isValidPairingToken(this.state.token)) {
        throw new Error("Mesh state is missing a valid node identity or pairing token.");
      }
      if (typeof this.state.name !== "string" || !this.validName(this.state.name)) {
        throw new Error("Mesh state contains an invalid node name.");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = {
        version: 1,
        nodeId: randomBytes(8).toString("hex"),
        instanceId: null,
        name: hostname().slice(0, 32) || "Copilot node",
        token: randomBytes(32).toString("base64url"),
        peers: [],
        discovered: [],
        inbox: [],
        sent: [],
        routeSessions: [],
        threadActivity: [],
      };
      this.state.instanceId = this.state.nodeId;
      await this.persist();
    }
    this.state.instanceId = this.state.nodeId;
    await chmod(this.storageFile, 0o600);
    this.capabilities = await probeCapabilities();
    this.state.discovered = this.state.discovered.filter((peer) =>
      peer && typeof peer.nodeId === "string" && typeof peer.host === "string" && Number.isInteger(peer.port),
    );
  }

  validName(name) {
    return typeof name === "string"
      && name.trim().length > 0
      && name.length <= 32
      && !/[\/\\\u0000-\u001f\u007f]/.test(name);
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
      this.server = null;
      throw error;
    }
    this.port = this.server.address().port;
    if (this.discoveryEnabled) this.startDiscovery();
    for (const task of this.state.inbox) {
      if (task.status === "dispatching") this.startTaskDispatch(task.id);
    }
    return this.port;
  }

  async close() {
    for (const timer of this.discoveryTimers) clearInterval(timer);
    this.discoveryTimers = [];
    if (this.discoverySocket) {
      try {
        this.discoverySocket.close();
      } catch (error) {
        if (error.code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") throw error;
      }
      this.discoverySocket = null;
    }
    if (this.server?.listening) {
      await new Promise((resolveClose, rejectClose) => {
        this.server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }
    await Promise.allSettled(this.backgroundTasks);
  }

  async setName(value) {
    if (!this.validName(value)) {
      throw new Error("Machine name must be 1–32 characters and contain no slash or control characters.");
    }
    this.state.name = value.trim();
    await this.persist();
    this.announce();
    return { name: this.state.name };
  }

  selfRecord() {
    const capabilities = this.capabilities
      ? {
        os: this.capabilities.os,
        arch: this.capabilities.arch,
        cpuCores: this.capabilities.cpuCount,
        memMb: Math.round(this.capabilities.memoryBytes / (1024 * 1024)),
        runtimes: this.capabilities.runtimes,
        runtimesIncomplete: this.capabilities.runtimesIncomplete,
        probeFailCount: this.capabilities.probeFailCount,
        gpu: null,
        workspaceHints: [],
        capabilitiesAt: this.capabilities.capabilitiesAt,
      }
      : null;
    return {
      v: 2,
      app: "dsh-mesh",
      id: this.state.instanceId,
      instanceId: this.state.instanceId,
      nodeId: this.state.nodeId,
      machine: this.state.name,
      name: this.state.name,
      hostname: hostname(),
      host: localAddresses()[0] || "",
      port: this.port,
      os: this.capabilities?.os || "",
      version: "1.0.0",
      capabilities,
      ts: Date.now(),
    };
  }

  startDiscovery() {
    if (this.discoverySocket) return;
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    this.discoverySocket = socket;
    socket.on("error", (error) => {
      this.discoveryError = error.message.slice(0, 200);
    });
    socket.on("message", (message, remote) => {
      if (message.length > 8192) return;
      try {
        const record = JSON.parse(message.toString("utf8"));
        const peerId = record.id || record.instanceId || record.nodeId;
        const peerName = record.machine || record.name;
        if (!["dsh-mesh", "copilot-plugin-mesh"].includes(record.app)
          || typeof peerId !== "string"
          || !/^[a-f0-9]{16,32}$/.test(peerId)
          || peerId === this.state.nodeId
          || typeof peerName !== "string"
          || !Number.isInteger(record.port)
          || record.port < 1
          || record.port > 65535
          || !isPrivateAddress(remote.address)) return;
        this.observePeer({
          nodeId: peerId,
          name: peerName.slice(0, 32),
          host: remote.address,
          port: record.port,
          capabilities: sanitizeCapabilities(record.capabilities),
          capabilitiesAt: Number.isFinite(record.capabilities?.capabilitiesAt) ? record.capabilities.capabilitiesAt : 0,
          lastSeen: Date.now(),
          paired: this.state.peers.some((peer) => peer.nodeId === peerId),
        });
      } catch {
        return;
      }
    });
    socket.bind(this.discoveryPort, "0.0.0.0", () => {
      try {
        socket.addMembership(this.discoveryGroup);
        socket.setMulticastTTL(1);
        socket.setMulticastLoopback(true);
        this.announce();
        const announceTimer = setInterval(() => this.announce(), 5000);
        announceTimer.unref?.();
        this.discoveryTimers.push(announceTimer);
        const cleanupTimer = setInterval(() => this.expirePeers(), 5000);
        cleanupTimer.unref?.();
        this.discoveryTimers.push(cleanupTimer);
        const healthTimer = setInterval(() => {
          for (const peer of this.state.peers) {
            this.refreshPeer(peer.id).catch((error) => {
              const record = this.state.peers.find((item) => item.id === peer.id);
              if (record?.status === "online") {
                record.status = "offline";
                record.lastError = error.message.slice(0, 160);
                this.persist().catch(() => {});
              }
            });
          }
          this.probeDiscoveredPeers().catch((error) => {
            this.discoveryError = error.message.slice(0, 200);
          });
        }, 10_000);
        healthTimer.unref?.();
        this.discoveryTimers.push(healthTimer);
        const scanTimer = setInterval(() => {
          this.scan().catch((error) => { this.discoveryError = error.message.slice(0, 200); });
        }, 60_000);
        scanTimer.unref?.();
        this.discoveryTimers.push(scanTimer);
        const startupScan = setTimeout(() => {
          this.scan().catch((error) => { this.discoveryError = error.message.slice(0, 200); });
        }, 1500);
        startupScan.unref?.();
        this.discoveryTimers.push(startupScan);
        const capabilityTimer = setInterval(async () => {
          try {
            this.capabilities = await probeCapabilities();
            this.announce();
          } catch (error) {
            this.discoveryError = error.message.slice(0, 200);
          }
        }, 10 * 60_000);
        capabilityTimer.unref?.();
        this.discoveryTimers.push(capabilityTimer);
      } catch (error) {
        this.discoveryError = error.message.slice(0, 200);
      }
    });
  }

  announce() {
    if (!this.discoverySocket || !this.port) return;
    const message = Buffer.from(JSON.stringify(this.selfRecord()));
    this.discoverySocket.send(message, this.discoveryPort, this.discoveryGroup, (error) => {
      if (error) this.discoveryError = error.message.slice(0, 200);
    });
  }

  observePeer(peer) {
    const paired = this.state.peers.find((item) => item.nodeId === peer.nodeId);
    if (paired) {
      paired.name = peer.name;
      paired.host = peer.host;
      paired.port = peer.port;
      paired.status = "online";
      paired.lastSeen = new Date(peer.lastSeen).toISOString();
      if (peer.capabilitiesAt >= (paired.capabilitiesAt || 0)) {
        paired.capabilities = peer.capabilities;
        paired.capabilitiesAt = peer.capabilitiesAt;
      }
      this.persist().catch(() => {});
      return;
    }
    this.state.discovered = this.state.discovered.filter((item) =>
      item.nodeId === peer.nodeId || item.host !== peer.host || item.port !== peer.port,
    );
    const index = this.state.discovered.findIndex((item) => item.nodeId === peer.nodeId);
    if (index >= 0) {
      const old = this.state.discovered[index];
      if (peer.lastSeen < old.lastSeen) return;
      this.state.discovered[index] = { ...old, ...peer };
    } else {
      this.state.discovered.push(peer);
    }
    this.state.discovered = this.state.discovered.slice(-MAX_HISTORY);
  }

  expirePeers() {
    const now = Date.now();
    this.state.discovered = this.state.discovered
      .filter((peer) => now - peer.lastSeen <= PEER_KEEP_MS)
      .map((peer) => ({
        ...peer,
        status: now - peer.lastSeen > PEER_TTL_MS ? "offline" : "online",
      }));
  }

  async probeDiscoveredPeer(peer) {
    const host = peer.host.includes(":") ? `[${peer.host}]` : peer.host;
    let record;
    try {
      const response = await fetch(`http://${host}:${peer.port}${API_PREFIX}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return false;
      record = await response.json();
    } catch {
      return false;
    }
    const peerId = record.id || record.instanceId || record.nodeId;
    if (peerId !== peer.nodeId) return false;
    const peerName = record.machine || record.name;
    this.observePeer({
      nodeId: peer.nodeId,
      name: typeof peerName === "string" ? peerName.slice(0, 32) : peer.name,
      host: peer.host,
      port: Number.isInteger(record.port) ? record.port : peer.port,
      capabilities: sanitizeCapabilities(record.capabilities),
      capabilitiesAt: Number.isFinite(record.capabilities?.capabilitiesAt) ? record.capabilities.capabilitiesAt : 0,
      lastSeen: Date.now(),
      paired: this.state.peers.some((item) => item.nodeId === peer.nodeId),
    });
    return true;
  }

  async probeDiscoveredPeers() {
    const peers = [...this.state.discovered];
    await Promise.allSettled(peers.map((peer) => this.probeDiscoveredPeer(peer)));
  }

  async scan() {
    const own = new Set(localAddresses());
    const targets = new Set();
    for (const address of localAddresses()) {
      if (isIP(address) !== 4) continue;
      const octets = address.split(".").map(Number);
      const prefix = `${octets[0]}.${octets[1]}.${octets[2]}.`;
      for (let host = 1; host < 255; host++) {
        const candidate = `${prefix}${host}`;
        if (!own.has(candidate)) targets.add(candidate);
      }
    }
    const queue = [...targets];
    let found = 0;
    const worker = async () => {
      while (queue.length) {
        const host = queue.pop();
        try {
          const response = await fetch(`http://${host}:${DEFAULT_PEER_PORT}${API_PREFIX}/health`, {
            signal: AbortSignal.timeout(800),
          });
          if (!response.ok) continue;
          const record = await response.json();
          const peerId = record.id || record.instanceId || record.nodeId;
          const peerName = record.machine || record.name;
          if (!["dsh-mesh", "copilot-plugin-mesh"].includes(record.app)
            || typeof peerId !== "string"
            || peerId === this.state.nodeId) continue;
          this.observePeer({
            nodeId: peerId,
            name: typeof peerName === "string" ? peerName.slice(0, 32) : host,
            host,
            port: Number.isInteger(record.port) ? record.port : DEFAULT_PEER_PORT,
            capabilities: sanitizeCapabilities(record.capabilities),
            capabilitiesAt: Number.isFinite(record.capabilities?.capabilitiesAt) ? record.capabilities.capabilitiesAt : 0,
            lastSeen: Date.now(),
            paired: this.state.peers.some((peer) => peer.nodeId === peerId),
          });
          found += 1;
        } catch {
          continue;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(64, queue.length) }, () => worker()));
    return { scanned: targets.size, found, peers: this.localState().discovered };
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
        ...this.selfRecord(),
        nodeId: this.state.nodeId,
      });
      return;
    }

    if (!url.pathname.startsWith(`${API_PREFIX}/`) && url.pathname !== API_PREFIX) {
      this.sendJson(response, 404, { ok: false, error: "Not found." });
      return;
    }
    const requestToken = request.headers["x-dsh-mesh-token"] || request.headers["x-plugin-mesh-token"];
    const paired = isValidToken(requestToken, this.state.token)
      || this.state.peers.some((peer) => isValidToken(requestToken, peer.token));
    const requestAddress = request.socket.remoteAddress?.replace(/^::ffff:/, "") || "";
    const isPrivateTaskSubmission = request.method === "POST"
      && url.pathname === `${API_PREFIX}/task`
      && isPrivateAddress(requestAddress);
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/hello`) {
      this.sendJson(response, 200, {
        ok: true,
        ...this.selfRecord(),
        nodeId: this.state.nodeId,
        peerPaired: paired,
        paired,
        reviewOnly: true,
      });
      return;
    }
    if (!paired && !isPrivateTaskSubmission) {
      this.sendJson(response, 403, { ok: false, error: "Pairing token is missing or invalid." });
      return;
    }

    if (request.method === "GET" && url.pathname === `${API_PREFIX}/peers`) {
      this.sendJson(response, 200, {
        ok: true,
        peers: [
          ...this.state.peers.map((peer) => ({ ...safePeer(peer), online: peer.status === "online" })),
          ...this.state.discovered.map((peer) => ({
            id: peer.nodeId,
            nodeId: peer.nodeId,
            machine: peer.name,
            host: peer.host,
            port: peer.port,
            online: peer.status === "online",
            paired: false,
            capabilities: peer.capabilities ?? null,
            capabilitiesAt: peer.capabilitiesAt ?? 0,
          })),
        ],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/tasks`) {
      const tasks = this.state.inbox.slice(-50).reverse();
      this.sendJson(response, 200, {
        ok: true,
        tasks,
        inbox: tasks,
        sent: this.state.sent.slice(-50).reverse(),
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
        this.sendJson(response, 413, { ok: false, error: "Task text exceeds 256 KiB." });
        return;
      }

      const id = typeof body.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(body.id)
        ? body.id
        : randomBytes(12).toString("hex");
      const existing = this.state.inbox.find((item) => item.id === id);
      if (existing) {
        this.sendJson(response, 200, { ok: true, id, duplicate: true, status: existing.status });
        return;
      }

      const task = {
        id,
        fromNodeId: typeof body.fromNodeId === "string" ? body.fromNodeId.slice(0, 64) : "unknown",
        from: typeof body.from === "string" ? body.from.slice(0, 128) : "",
        fromName: typeof body.fromMachine === "string"
          ? body.fromMachine.slice(0, 64)
          : typeof body.fromName === "string" ? body.fromName.slice(0, 64) : "Unknown peer",
        fromMachine: typeof body.fromMachine === "string" ? body.fromMachine.slice(0, 64) : null,
        task: body.task,
        thread: typeof body.thread === "string" ? body.thread.slice(0, 128) : "",
        originSession: typeof body.originSession === "string" ? body.originSession.slice(0, 128) : "",
        noWake: body.noWake === true,
        newSession: body.newSession === true,
        authenticated: paired,
        workspace: typeof body.workspace === "string" ? body.workspace.slice(0, 512) : "",
        receivedAt: new Date().toISOString(),
        sourceAddress: request.socket.remoteAddress || "",
        transport: "lan",
        status: "awaiting-review",
        routeDecision: "Stored for explicit user review.",
        dispatchError: "",
        replyTo: {
          machine: typeof body.fromMachine === "string" ? body.fromMachine.slice(0, 64) : "",
          session: typeof body.originSession === "string" ? body.originSession.slice(0, 128) : "",
          thread: typeof body.thread === "string" ? body.thread.slice(0, 128) : "",
        },
      };
      this.prepareIncomingTask(task, requestAddress);
      this.state.inbox.push(task);
      this.state.inbox = this.state.inbox.slice(-MAX_HISTORY);
      await this.persist();
      this.sendJson(response, 200, { ok: true, id, duplicate: false, status: task.status });
      if (task.status === "dispatching") this.startTaskDispatch(task.id);
      return;
    }
    this.sendJson(response, 404, { ok: false, error: "Not found." });
  }

  localState({ includeToken = false } = {}) {
    this.expirePeers();
    return {
      nodeId: this.state.nodeId,
      name: this.state.name,
      ...(includeToken ? { token: this.state.token } : {}),
      port: this.port,
      addresses: localAddresses(),
      capabilities: this.capabilities,
      discoveryError: this.discoveryError,
      discovered: this.state.discovered.map((peer) => ({
        nodeId: peer.nodeId,
        name: peer.name,
        host: peer.host,
        port: peer.port,
        status: peer.status,
        lastSeen: peer.lastSeen,
        capabilities: peer.capabilities,
        capabilitiesStale: peer.capabilities === null || peer.capabilitiesAt <= 0
          ? null
          : Date.now() - peer.capabilitiesAt > 10 * 60_000,
        paired: false,
      })),
      peers: this.state.peers.map((peer) => ({
        ...safePeer(peer),
        host: peer.host,
        port: peer.port,
        os: peer.os ?? "",
        capabilities: peer.capabilities ?? null,
        capabilitiesStale: peer.capabilities == null || peer.capabilitiesAt <= 0
          ? null
          : Date.now() - peer.capabilitiesAt > 10 * 60_000,
      })),
      inbox: this.state.inbox.slice(-MAX_HISTORY).reverse(),
      sent: this.state.sent.slice(-MAX_HISTORY).reverse(),
    };
  }

  async addPeer({ name, url, token }) {
    if (!this.validName(name)) {
      throw new Error("Peer name must be 1–32 characters and contain no slash or control characters.");
    }
    if (!isValidPairingToken(token)) {
      throw new Error("Peer pairing token must be a valid token copied from that peer.");
    }
    const normalizedUrl = normalizePeerUrl(url);
    const response = await fetch(`${normalizedUrl}${API_PREFIX}/hello`, {
      headers: { "X-Dsh-Mesh-Token": token },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      if (response.status === 403) throw new Error("Peer rejected the token. Copy the target peer's pairing token.");
      throw new Error(`Peer handshake failed (${response.status}).`);
    }
    const remote = await response.json();
    const remoteId = remote.id || remote.instanceId || remote.nodeId;
    if (!remote.ok || typeof remoteId !== "string" || !/^[a-f0-9]{16,32}$/.test(remoteId)) {
      throw new Error("Peer returned an invalid handshake response.");
    }
    if (remote.peerPaired === false || remote.paired === false) {
      throw new Error("The peer does not accept this pairing token.");
    }
    const existing = this.state.peers.find((peer) => peer.nodeId === remoteId || peer.url === normalizedUrl);
    const peer = {
      id: remoteId,
      nodeId: remoteId,
      name: name.trim(),
      url: normalizedUrl,
      host: new URL(normalizedUrl).hostname.replace(/^\[|\]$/g, ""),
      port: Number(new URL(normalizedUrl).port) || DEFAULT_PEER_PORT,
      token,
      os: typeof remote.os === "string" ? remote.os.slice(0, 96) : "",
      capabilities: sanitizeCapabilities(remote.capabilities),
      capabilitiesAt: Number.isFinite(remote.capabilities?.capabilitiesAt) ? remote.capabilities.capabilitiesAt : 0,
      status: "online",
      lastSeen: new Date().toISOString(),
    };
    if (existing) Object.assign(existing, peer);
    else this.state.peers.push(peer);
    this.state.discovered = this.state.discovered.filter((item) => item.nodeId !== peer.nodeId);
    await this.persist();
    return safePeer(peer);
  }

  async refreshPeer(id) {
    const peer = this.state.peers.find((item) => item.id === id);
    if (!peer) throw new Error("Peer not found.");
    const response = await fetch(`${peer.url}${API_PREFIX}/hello`, {
      headers: { "X-Dsh-Mesh-Token": peer.token },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      peer.status = response.status === 403 ? "unpaired" : "offline";
      await this.persist();
      throw new Error(response.status === 403 ? "Peer no longer accepts this pairing token." : `Peer is unreachable (${response.status}).`);
    }
    const remote = await response.json();
    if (!remote.ok || (remote.id || remote.instanceId || remote.nodeId) !== peer.nodeId) {
      peer.status = "identity-changed";
      await this.persist();
      throw new Error("Peer identity changed. Remove it and pair the new identity explicitly.");
    }
    peer.name = typeof (remote.machine || remote.name) === "string" ? (remote.machine || remote.name).slice(0, 32) : peer.name;
    peer.os = typeof remote.os === "string" ? remote.os.slice(0, 96) : peer.os;
    if (Number.isFinite(remote.capabilities?.capabilitiesAt) && remote.capabilities.capabilitiesAt >= (peer.capabilitiesAt || 0)) {
      peer.capabilities = sanitizeCapabilities(remote.capabilities);
      peer.capabilitiesAt = remote.capabilities.capabilitiesAt;
    }
    peer.host = new URL(peer.url).hostname.replace(/^\[|\]$/g, "");
    peer.port = Number(new URL(peer.url).port) || DEFAULT_PEER_PORT;
    peer.status = "online";
    peer.lastSeen = new Date().toISOString();
    this.observePeer({
      nodeId: peer.nodeId,
      name: peer.name,
      host: peer.host,
      port: peer.port,
      capabilities: peer.capabilities,
      capabilitiesAt: peer.capabilitiesAt || 0,
      lastSeen: Date.now(),
      paired: true,
    });
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

  async sendTask({ peerId, task, thread = "", noWake = false }) {
    const peer = this.state.peers.find((item) => item.id === peerId);
    if (!peer) throw new Error("Peer not found. Add and pair it first.");
    if (typeof task !== "string" || task.trim().length === 0) throw new Error("Task text is required.");
    if (Buffer.byteLength(task, "utf8") > MAX_TASK_LENGTH) throw new Error("Task text exceeds 256 KiB.");
    if (typeof thread !== "string" || thread.length > 128) throw new Error("Thread must be at most 128 characters.");
    if (typeof noWake !== "boolean") throw new Error("noWake must be a boolean.");

    const id = `t-${randomBytes(12).toString("hex")}`;
    const record = {
      id,
      peerId: peer.id,
      peerName: peer.name,
      task,
      thread,
      noWake,
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
          "X-Dsh-Mesh-Token": peer.token,
        },
        body: JSON.stringify({
          id,
          fromNodeId: this.state.nodeId,
          fromName: this.state.name,
          fromMachine: this.state.name,
          from: this.state.name,
          thread: thread || undefined,
          noWake,
          task,
        }),
        signal: AbortSignal.timeout(8000),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `Peer rejected the task (${response.status}).`);
      record.status = result.duplicate
        ? "already-received"
        : ["awaiting-review", "noted-only"].includes(result.status) ? "accepted-for-review" : "accepted";
      record.response = result.status;
      peer.status = "online";
      peer.lastSeen = new Date().toISOString();
      await this.persist();
      return {
        accepted: true,
        id,
        status: record.status,
        noWake,
        message: noWake
          ? "Delivered to the peer inbox without waking its agent."
          : "Delivered; the peer's inbound policy decides whether to wake an agent.",
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

  prepareIncomingTask(task, requestAddress) {
    const text = task.task.trim();
    if (task.noWake) {
      task.status = "noted-only";
      task.routeDecision = "The sender requested noWake; the task is stored without creating a session.";
      return;
    }
    if ([...text].length < MIN_TASK_CHARS || NOTICE_ONLY_PATTERN.test(text)) {
      task.status = "noted-only";
      task.routeDecision = "Short or notice-only message; no session was created.";
      return;
    }
    if (typeof this.taskDispatcher !== "function") {
      task.status = "awaiting-review";
      task.routeDecision = "No isolated task-session dispatcher is available.";
      return;
    }

    const threadName = task.thread || task.originSession || "default";
    const threadKey = createHash("sha256")
      .update(`${requestAddress}\0${threadName}`)
      .digest("hex");
    const now = this.now();
    let activity = this.state.threadActivity.find((entry) => entry.key === threadKey);
    if (!activity) {
      activity = { key: threadKey, wakeTimes: [], lastNewSessionAt: null };
      this.state.threadActivity.push(activity);
    }
    activity.wakeTimes = activity.wakeTimes.filter((timestamp) =>
      timestamp <= now && now - timestamp < THREAD_WINDOW_MS,
    );
    const route = this.state.routeSessions.find((entry) => entry.key === threadKey);
    const createSession = task.newSession || !route;
    if (activity.wakeTimes.length >= MAX_WAKES_PER_THREAD) {
      task.status = "rate-limited";
      task.routeDecision = "Thread wake limit reached (30 per hour).";
      return;
    }
    if (createSession && activity.lastNewSessionAt !== null && now - activity.lastNewSessionAt < THREAD_COOLDOWN_MS) {
      task.status = "rate-limited";
      task.routeDecision = "New-session cooldown active for this thread.";
      return;
    }

    if (createSession) {
      activity.lastNewSessionAt = now;
      const newRoute = { key: threadKey, sessionId: null, createdAt: now, lastUsedAt: now };
      if (route) Object.assign(route, newRoute);
      else this.state.routeSessions.push(newRoute);
    }
    activity.wakeTimes.push(now);
    this.state.threadActivity = this.state.threadActivity.slice(-MAX_HISTORY);
    this.state.routeSessions = this.state.routeSessions.slice(-MAX_HISTORY);
    task.threadKey = threadKey;
    task.createSession = createSession;
    task.status = "dispatching";
    task.routeDecision = "Queued in an isolated task session with tools disabled.";
  }

  startTaskDispatch(id) {
    const operation = this.dispatchIncomingTask(id);
    this.backgroundTasks.add(operation);
    operation.catch((error) => {
      this.onError?.(error);
    }).finally(() => {
      this.backgroundTasks.delete(operation);
    });
  }

  async dispatchIncomingTask(id) {
    const task = this.state.inbox.find((entry) => entry.id === id);
    if (!task || task.status !== "dispatching") return;
    try {
      const route = this.state.routeSessions.find((entry) => entry.key === task.threadKey);
      const result = await this.taskDispatcher(task, {
        routeKey: task.threadKey,
        sessionId: route?.sessionId ?? null,
        createSession: task.createSession === true,
        onSessionCreated: async (sessionId) => {
          if (typeof sessionId !== "string" || sessionId.length === 0) {
            throw new Error("Task-session dispatcher returned an invalid session ID.");
          }
          const currentRoute = this.state.routeSessions.find((entry) => entry.key === task.threadKey);
          if (currentRoute) {
            currentRoute.sessionId = sessionId;
            currentRoute.lastUsedAt = this.now();
          }
          task.sessionId = sessionId;
          await this.persist();
        },
      });
      if (!result || typeof result.sessionId !== "string" || result.sessionId.length === 0) {
        throw new Error("Task-session dispatcher did not return a session ID.");
      }
      task.sessionId = result.sessionId;
      task.result = typeof result.result === "string" ? result.result.slice(0, 16_384) : "";
      task.status = "completed";
      task.routeDecision = "Completed in an isolated task session with tools disabled.";
      if (route) route.lastUsedAt = this.now();
    } catch (error) {
      task.status = "failed";
      task.dispatchError = error instanceof Error ? error.message.slice(0, 512) : "Unknown task-session error.";
      task.routeDecision = "The isolated task session could not complete the request.";
    }
    await this.persist();
  }
}

export function createMeshRuntime({
  copilotHome = process.env.COPILOT_HOME || resolve(homedir(), ".copilot"),
  port,
  host,
  discovery,
  discoveryGroup,
  discoveryPort,
  taskDispatcher,
  now,
  onError,
} = {}) {
  return new MeshRuntime({
    storageFile: resolve(copilotHome, "extensions", "plugin-mesh", "artifacts", "mesh-state.json"),
    ...(port === undefined ? {} : { port }),
    ...(host === undefined ? {} : { host }),
    ...(discovery === undefined ? {} : { discovery }),
    ...(discoveryGroup === undefined ? {} : { discoveryGroup }),
    ...(discoveryPort === undefined ? {} : { discoveryPort }),
    ...(taskDispatcher === undefined ? {} : { taskDispatcher }),
    ...(now === undefined ? {} : { now }),
    ...(onError === undefined ? {} : { onError }),
  });
}
