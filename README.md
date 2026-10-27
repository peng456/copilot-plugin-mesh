# copilot-plugin-mesh

A minimal Copilot CLI extension that demonstrates a plugin mesh: a central registry of built-in and custom plugins with a canvas UI and action-based invocation workflow.

## Features

- Canvas-backed UI for plugin inspection
- Registry listing via `list_plugins`
- Plugin registration with `register_plugin`
- Sequential plugin execution via `invoke_plugin`
- Simple built-in plugins: `echo`, `time`, `uppercase`, and `ping`

## Extension location

The project-scoped extension lives under:

- `.github/extensions/plugin-mesh/extension.mjs`

## Local validation

Run a syntax check with Node:

```bash
node --check .github/extensions/plugin-mesh/extension.mjs
```

## GitHub sync

Push the repo to GitHub after the initial commit:

```bash
git add .
git commit -m "Initial plugin mesh extension"
git remote add origin git@github.com:<your-user>/copilot-plugin-mesh.git
git push -u origin main
```
