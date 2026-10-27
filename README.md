# Copilot Plugin Mesh

Copilot CLI adaptation of the node discovery, capability-card, pairing, peer health, and task protocol in [dsh-plugin-mesh](https://github.com/peng456/dsh-plugin-mesh).

## Implemented

- Stable 16-character node identity and editable 32-character machine name, persisted with a private pairing token under `$COPILOT_HOME/extensions/plugin-mesh/artifacts/mesh-state.json` (default: `~/.copilot/extensions/plugin-mesh/artifacts/mesh-state.json`).
- DSH Mesh v2-compatible multicast cards (`239.255.42.99:45892`), IPv4 /24 health scan on port `45917`, periodic re-announcement, peer health checks, offline/expiry tracking, and private-network address reporting.
- Bounded capability cards for OS, architecture, CPU, memory, and installed runtimes. Probe failures are reported as incomplete; local diagnostics are not broadcast.
- DSH Mesh v1-style `/mesh/v1/health`, `/hello`, `/peers`, `/tasks`, and `/task` endpoints, including the `X-Dsh-Mesh-Token` header, idempotency, task size limits, and 0600 state-file permissions.
- Mesh canvas for discovered/paired peers, explicit pairing, task dispatch, inbox review, and sent/received history.
- Read-only agent-facing canvas actions: `mesh_status`, `mesh_peers`, and `mesh_tasks`. Peer pairing, scanning, task sending, copying, and dismissing stay user-driven canvas actions.
- Local plugin registry and sequential invocation (`echo`, `time`, `uppercase`, `ping`).

## Intentional safety boundary

Incoming task bodies are untrusted text. They are persisted and displayed in the review inbox; the extension never wakes a Copilot agent, injects a task into a session, or executes a remote task. Outgoing requests include `noWake: true` for DSH peers. The user must explicitly inspect and decide what to do with an incoming request.

Pairing is always required on this Copilot node. A discovered card is not a trusted peer: to pair, copy the peer's token over a trusted channel and complete the handshake in the canvas. The local token and tokens of explicitly paired peers are accepted for inbound requests, which supports DSH's shared-token pairing model. Tokens travel over plain HTTP, so use only a trusted private network or a separately secured tunnel. The listener binds to all interfaces; `/health` is public and the control endpoints require an accepted pairing token. The mesh refuses public IPs for manual pairing; discovery and active scanning are limited to local private IPv4 networks.

## Deliberate differences from dsh-plugin-mesh

- The optional Tailscale/tsnet sidecar and non-LAN routing are not included.
- This Copilot adapter does not provide `mesh_run` as an agent tool or automatically route inbound tasks into Copilot sessions. That would violate the review-only boundary above. Dispatch remains an explicit canvas action and is marked `noWake`.
- The reference's configurable scan ranges/ports and full cross-session reply binding are not implemented.

## Pair and use

1. Install the extension on both nodes and open **Copilot Mesh**.
2. The canvas displays multicast/scan discoveries, the local HTTP port, and a hidden-by-default pairing token. Reveal and transfer each token out of band.
3. Pair each node from the other node's canvas. Discovery alone does not establish trust.
4. Choose a paired peer and submit a task request. It is sent with `noWake: true`; inspect the delivery status because acceptance only confirms receipt.
5. Review incoming tasks in the inbox. They may be copied or dismissed, but are never automatically sent to Copilot.

The listener uses port `45917` and falls back to an OS-assigned port if unavailable. Its current port is shown in the canvas. In fallback mode, multicast discovery advertises the selected port; active IPv4 scans use the reference port `45917`.

## Validation

Requires Node.js 20 or newer:

```bash
node --check .github/extensions/plugin-mesh/extension.mjs
node --check .github/extensions/plugin-mesh/mesh-runtime.mjs
node --test .github/extensions/plugin-mesh/mesh-runtime.test.mjs
```
