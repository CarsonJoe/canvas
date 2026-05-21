# Cogniboom Canvas MCP

Local helper for connecting Cogniboom Canvas to MCP-capable agent clients.

## Setup

```sh
npm install -g @cogniboom/canvas
canvas setup
```

HTTP MCP endpoint:

```text
http://127.0.0.1:3762/mcp
```

Stdio command:

```sh
canvas serve
```

## Commands

```text
canvas serve    Start stdio MCP and the local Canvas app (auto-updates on launch).
canvas http     Start the local Canvas app and HTTP MCP endpoint.
canvas setup    Open the setup guide in your browser.
canvas doctor   Diagnose local setup.
canvas version  Print helper and protocol versions.
canvas update   Open the setup guide in your browser.
```

The helper binds to `127.0.0.1` by default.
