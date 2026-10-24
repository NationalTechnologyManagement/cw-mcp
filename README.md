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

## Secrets (Azure Key Vault)

The ConnectWise API keys are not stored on Railway. On boot, `vault.js` — the
first import in `server.js`, evaluated to completion (top-level `await`) before
any of the server's own `process.env` reads run — fetches them from the
**kv-ntm-apps** Key Vault and writes each one into `process.env` under the
variable name the server already uses. The vault wins over anything the
platform or `.env` has set.

| Environment variable | Vault secret     | Shared with                     |
| -------------------- | ---------------- | ------------------------------- |
| `CW_CLIENT_ID`       | `cw-client-id`   | every NTM service (one key set) |
| `CW_PUBLIC_KEY`      | `cw-public-key`  | every NTM service (one key set) |
| `CW_PRIVATE_KEY`     | `cw-private-key` | every NTM service (one key set) |

Only these four variables stay on Railway. They authenticate the service to the
vault as a service principal that holds **Key Vault Secrets User** on the vault
and nothing else:

```env
AZURE_KEY_VAULT_URL=https://kv-ntm-apps.vault.azure.net
AZURE_TENANT_ID=...
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
```

The vault firewall denies by default and admits only this service's Railway
**Static Outbound IPs** (Settings > Networking on the `cw-mcp-server` service).
If the service moves region or static IPs are toggled, add the new addresses to
the vault's network rules before the next deploy, or boot fails with a 403 from
the vault.

Leave `AZURE_KEY_VAULT_URL` unset for local development: the loader logs
`[vault] AZURE_KEY_VAULT_URL not set` and the keys come from `.env` as before.
A vault that is configured but unreachable, or that refuses the credential, is
fatal on boot. A single secret missing from the vault is logged
(`not in vault (environment fallback)`) and the environment value, if any, is
used. The loader logs to stderr so the stdio transport's protocol stream on
stdout is never corrupted. To rotate a key, set a new version of the secret in
the vault and redeploy; nothing on Railway changes.

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
