# cw-mcp

ConnectWise Manage MCP server for Claude. Exposes 51 tools over the Model Context
Protocol covering service tickets, service/task templates, board auto-templates,
companies, contacts, time entries, projects, opportunities, procurement, agreements,
and system lookups (members, boards, priorities, statuses).

## Running

```bash
cp .env.example .env   # fill in CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID
npm ci
npm start              # stdio transport (local Claude Desktop / Claude Code)
PORT=3000 npm start    # Streamable HTTP transport (Railway)
```

| Variable          | Required | Default                          |
|-------------------|----------|----------------------------------|
| `CW_PUBLIC_KEY`   | yes      |                                  |
| `CW_PRIVATE_KEY`  | yes      |                                  |
| `CW_CLIENT_ID`    | yes      |                                  |
| `CW_BASE_URL`     | no       | `https://na.myconnectwise.net`   |
| `CW_COMPANY_ID`   | no       | `ntm`                            |
| `CW_TIMEOUT_MS`   | no       | `30000`                          |
| `PORT`            | no       | unset = stdio mode               |

HTTP mode: `GET /health` returns `{"status":"ok"}`; the MCP endpoint is `POST /`.

## Deploy

Pushing to `main` triggers a Railway build of the `cw-mcp-server` service
(Dockerfile builder, `npm ci --omit=dev`). Production:
`https://cw-mcp-server-production.up.railway.app`.

## Smoke test

```bash
CW_PUBLIC_KEY=x CW_PRIVATE_KEY=y CW_CLIENT_ID=z PORT=3123 node server.js &
curl -s localhost:3123/health
curl -s -X POST localhost:3123/ \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
