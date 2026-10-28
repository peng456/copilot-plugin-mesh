# Copilot Plugin Mesh

Copilot CLI adaptation of the node discovery, capability-card, pairing, peer health, and task protocol in [dsh-plugin-mesh](https://github.com/peng456/dsh-plugin-mesh).

## Implemented

- Stable 16-character node identity and editable 32-character machine name, persisted with a private pairing token under `$COPILOT_HOME/extensions/plugin-mesh/artifacts/mesh-state.json` (default: `~/.copilot/extensions/plugin-mesh/artifacts/mesh-state.json`).
- DSH Mesh v2-compatible multicast cards (`239.255.42.99:45892`), IPv4 /24 health scan on port `45917`, periodic re-announcement, peer health checks, offline/expiry tracking, and private-network address reporting.
- Bounded capability cards for OS, architecture, CPU, memory, and installed runtimes. Probe failures are reported as incomplete; local diagnostics are not broadcast.
- DSH Mesh v1-style `/mesh/v1/health`, `/hello`, `/peers`, `/tasks`, and `/task` endpoints, including the `X-Dsh-Mesh-Token` header, idempotency, task size limits, and 0600 state-file permissions.
- Mesh canvas for discovered/paired peers, task dispatch to either kind of peer, an explicit `requirePairing` switch, optional pairing, inbox review, and sent/received history.
- DSH-style inbound routing: `noWake`, short/notice filtering, per-thread session reuse, a 5-second new-session cooldown, and a 30-wake/hour thread limit.
- Normal inbound requests are handled in separate named Copilot sessions, not injected into the current conversation.
- Task sessions keep tools available by default, matching DSH's `workspace-write` permission preset, and run inside a dedicated `mesh-receive-task` workspace under the same operating-system sandbox as that preset (writes confined to the workspace, no network); `COPILOT_MESH_TASK_TOOLS=none` runs them without tools.
- A completed task is returned to the sender once as a normal woken answer (`noWake: false`), matching DSH's rule that only pure receipts carry `noWake`, and a receipt is never answered again, so peers cannot loop. An answer that a peer still marks `noWake` is also matched against our own outbound task and woken anyway, so a reply is never silently filed as a notice.
- Read-only agent-facing canvas actions: `mesh_status`, `mesh_peers`, and `mesh_tasks`. Peer pairing, scanning, task sending, copying, and dismissing stay user-driven canvas actions.
- If the mesh port is already owned by a leftover process from the previous launch, the canvas stays usable, reports the reason, and the listener keeps retrying in the background, so the node rejoins the mesh on its own instead of staying invisible until the next restart.
- The canvas keeps only the mesh panels: node status, peers, task dispatch, and the inbox. The earlier local plugin registry and plugin-chain runner were removed; `list_plugins` and `register_plugin` remain agent actions.

## Intentional safety boundary

Incoming task bodies are untrusted text. Normal requests automatically start or resume a separate named Copilot session; they are never injected into the current conversation. Tool access matches DSH: task sessions keep tools available, because DSH drives every inbound session with one `permissionPreset` (default `workspace-write`) and never derives it from pairing. That preset is an operating-system sandbox, so task sessions get the same one through `sandboxConfig` — reads are free, writes are confined to the receive workspace, sandbox bypass is refused, and the network is closed. Set `COPILOT_MESH_TASK_TOOLS=none` to lower that preset for every task. Task sessions always run with their own empty config directory (`$COPILOT_HOME/extensions/plugin-mesh/artifacts/task-session-config`) instead of the user's Copilot settings, so the user's MCP servers, custom instructions, and skills never load into them, and they work inside `$COPILOT_HOME/extensions/plugin-mesh/artifacts/mesh-receive-task` rather than a project checkout, so writes stay in that scratch directory. `noWake`, short messages, and greetings are stored as notices; thread cooldowns and hourly limits prevent repeated session creation. A completed task is returned to the sender once as a normal answer with `noWake: false`, because DSH's convention reserves `noWake` for pure receipts (`lib/prompt.js`: a receipt is relayed to the user and never re-dispatched). Sending the answer `noWake` made DSH file it as `noted-only`, so the result arrived and nobody ever read it. A message recognised as a receipt is never answered again, and loop safety comes from that, not from `noWake`. A peer that still marks its answer `noWake` is tolerated: the receipt is matched against the newest unanswered outbound task on the same peer and thread, and that match overrides both `noWake` and the short-message filter, recording `wakeOverride`. The match also accepts the peer's thread fallback: dsh replaces a missing thread with the task ID it received, so a threadless dispatch is still matched when the answer carries our task ID as its thread. Outgoing requests follow DSH Mesh defaults (`noWake: false` unless the user selects inbox-only delivery), so the peer's inbound policy may wake its agent or create a session. A dsh peer also drops anything shorter than its `minTaskChars` (default 24 in `classifyInbound`, 8 in its schema) into the inbox without waking its agent, which is why the canvas warns when the body is under 8 characters. Only dispatch to peers you trust.

Pairing is required to read mesh control endpoints. Outbound task dispatch follows dsh-plugin-mesh: any discovered peer is a dispatch target, and a paired peer is only preferred because it supplies that peer's own token — an unpaired target is sent our token instead. Private, loopback, and link-local sources may submit tasks without a token, which is why an unpaired LAN device can still start a task session; the token controls mesh control operations, not tool availability. Setting `requirePairing` (the canvas switch, off by default, or `state.requirePairing`) turns that door shut: unauthenticated task submissions are then rejected with 403 and every request needs a valid token, while `/health` and `/hello` stay public so discovery keeps working. Requests from public IPs are rejected either way. The local token and tokens of explicitly paired peers are also accepted for authenticated inbound requests, which supports DSH's shared-token pairing model. Tokens travel over plain HTTP, so use only a trusted private network or a separately secured tunnel. The listener binds to all interfaces; `/health` is public and control endpoints require an accepted pairing token. The mesh refuses public IPs for manual pairing; discovery and active scanning are limited to local private IPv4 networks. Restrict inbound task acceptance with `requirePairing`, `COPILOT_MESH_TASK_TOOLS=none`, or a firewall rule if unpaired devices must not run anything here.

## Deliberate differences from dsh-plugin-mesh

- The optional Tailscale/tsnet sidecar and non-LAN routing are not included.
- The Copilot adapter does not provide a `mesh_run` agent tool; task sessions cannot invoke mesh tools. Pairing, scanning, and outbound task dispatch remain user-driven canvas actions.
- Because there is no `mesh_run` tool, the reference's "agent dispatches its own answer with `mesh_run`" becomes a runtime step: a completed task is posted back once, as a normal answer with `noWake: false`, which is what DSH's own prompt tells its agent to do. The observable policy is the same — one answer per task, and receipts are never answered.
- The reference only marks a reply `isReply` and leaves a `noWake` answer unread. Here a receipt matched to an unanswered outbound task also overrides `noWake` and the short-message filter, and records `wakeOverride` plus the answered task's `repliedAt` so the exchange can be audited. Loop safety still comes from never answering a receipt.
- The reference's configurable scan ranges/ports and full cross-session reply binding are not implemented.
- The reference finds a reply route by looking the sender up in its own peer table by machine name. Android peers do not multicast and `dsh-mesh` sends no port, so a sender can be missing from that table entirely. Here the reply route is resolved from the sender's node id or machine name, and when the sender is unknown the inbound address is asked for its own `/health` across a narrow port window around the default port. A reply is never routed on host address alone, because two mesh nodes commonly share one machine.
- `permissionPreset` is mapped to `sandboxConfig` rather than a preset name, so the task session's sandbox is `workspace-write`-shaped but fixed: there is no `read-only` or `full-access` setting to select, only `COPILOT_MESH_TASK_TOOLS=none` to drop tools entirely.

## Pair and use

1. Install the extension on both nodes and open **Copilot Mesh**.
2. The canvas displays multicast/scan discoveries, the local HTTP port, and a hidden-by-default pairing token. Reveal and transfer each token out of band.
3. Optionally pair each node from the other node's canvas by transferring its token; pairing supplies that peer's token and is what `requirePairing` on the receiving side checks.
4. Choose a peer and submit a task request — discovered nodes are dispatchable directly, paired nodes are listed first. By default it is sent as a normal DSH task (`noWake: false`); optionally select inbox-only delivery. The peer's own inbound policy determines whether a normal task wakes an agent.
5. Normal inbound tasks are automatically routed to separate named sessions. Review the inbox for their status and text response; notices, rate-limited tasks, and failures remain available for review or dismissal.

The listener uses port `45917` and fails visibly if the port is unavailable; it never silently switches to an OS-assigned port. Its active port is shown in the canvas.

## Validation

Requires Node.js 20 or newer:

```bash
node --check .github/extensions/plugin-mesh/extension.mjs
node --check .github/extensions/plugin-mesh/mesh-runtime.mjs
node --check .github/extensions/plugin-mesh/mesh-task-sessions.mjs
node --test .github/extensions/plugin-mesh/mesh-runtime.test.mjs
```
