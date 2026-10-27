# Copilot Plugin Mesh

A Copilot CLI extension inspired by [dsh-plugin-mesh](https://github.com/peng456/dsh-plugin-mesh). It provides a small peer directory and a human-reviewed task inbox for connecting Copilot nodes over a trusted private network.

The HTTP API is Copilot-specific and is not wire-compatible with the DSH plugin protocol.

## What it does

- Gives each installation a persistent node ID and a random pairing token.
- Lets users add a peer by entering its private IP address, port, and pairing token.
- Exposes authenticated health, peer, and task endpoints on the mesh listener.
- Sends task requests to a paired node's inbox and persists received/sent history locally.
- Keeps the existing local plugin registry and sequential plugin-chain demo.

Received requests are untrusted text. They remain in the inbox until the user reviews them; the extension does **not** inject them into a Copilot session or execute them. The agent can inspect mesh status and task records, but pairing, sending, and dismissing requests are user-driven canvas actions.

## Pair two nodes

1. Install this extension on both machines and open the **Copilot Mesh** canvas in a running Copilot session on each.
2. On each machine, note a private address and port in the node panel, then reveal and copy that machine's pairing token using a trusted channel.
3. On machine A, enter machine B's private-IP URL and token. On machine B, enter machine A's URL and token. The peer must answer the authenticated handshake before it is saved.
4. Send a task request from the canvas. It appears in the other node's **待审核收件箱**; the recipient can inspect, copy, or ignore it.

The URL must use a literal private, loopback, or link-local IP address, for example `http://192.168.1.20:45917`. Public addresses and hostnames are rejected. The listener defaults to port `45917` and falls back to an OS-assigned port if unavailable; use the actual port shown in the canvas. The extension starts the listener when its provider starts, whether or not the canvas is open.

## Security and scope

- The mesh listener binds to all network interfaces. Pairing is always required for control endpoints; the token is generated locally and stored with mode `0600`.
- Pairing tokens travel over plain HTTP. Use only a trusted private network or a separately secured tunnel; this extension does not provide TLS.
- Health exposes only the node ID, display name, and port. Other endpoints require the pairing token and use constant-time token comparison.
- Requests are size-limited, task IDs are deduplicated, and remote task content is rendered as text.
- There is no subnet scan, automatic peer discovery, public-network peer support, Tailscale integration, automatic agent wake-up, or remote command execution.
- Run one active Copilot Mesh provider per machine. If the default port is occupied, the extension selects an ephemeral port, which is shown in the canvas and may change after restart.

State is stored under `$COPILOT_HOME/extensions/plugin-mesh/artifacts/mesh-state.json` (default: `~/.copilot/extensions/plugin-mesh/artifacts/mesh-state.json`).

## Canvas actions

Read-only mesh actions available to the agent:

- `mesh_status`
- `mesh_peers`
- `mesh_tasks`

User-driven canvas controls manage pairing, sending, and dismissing. The existing local plugin actions remain available: `list_plugins`, `register_plugin`, and `invoke_plugin`.

## Tests

Use Node.js 20 or newer:

```bash
node --check .github/extensions/plugin-mesh/extension.mjs
node --check .github/extensions/plugin-mesh/mesh-runtime.mjs
node --test .github/extensions/plugin-mesh/mesh-runtime.test.mjs
```
