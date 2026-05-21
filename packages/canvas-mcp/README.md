# Cogniboom Canvas MCP

Local helper for connecting Cogniboom Canvas to MCP-capable agent clients.

## Setup

```powershell
npx @cogniboom/canvas setup
```

HTTP MCP endpoint:

```text
http://127.0.0.1:3762/mcp
```

Stdio command:

```powershell
npx @cogniboom/canvas serve
```

## Commands

```text
canvas serve    Start stdio MCP and the local Canvas app.
canvas http     Start the local Canvas app and HTTP MCP endpoint.
canvas setup    Print client-specific setup instructions.
canvas doctor   Diagnose local setup.
canvas version  Print helper and protocol versions.
canvas update   Print update instructions.
```

The helper binds to `127.0.0.1` by default.
