// Azure Key Vault bootstrap — the ConnectWise API keys live in kv-ntm-apps, not
// in the host's environment.
//
// server.js imports this module FIRST and it uses top-level await, so by the time
// server.js reads process.env every secret below has already been written into
// the environment under the variable name the server already uses. Vault values
// win over anything the host set, so a stale variable left behind on the platform
// can never shadow the vault.
//
// Configuration (all read from the environment):
//   AZURE_KEY_VAULT_URL   https://kv-ntm-apps.vault.azure.net — unset disables the
//                         vault entirely (local dev falls back to .env).
//   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
//                         service principal holding Key Vault Secrets User on the
//                         vault. Picked up by DefaultAzureCredential, which also
//                         honours a managed identity or an `az login` session when
//                         those three are absent.
//
// A vault that is configured but unreachable, or a credential that is refused, is
// fatal: the server refuses to start rather than run with no ConnectWise keys. A
// single secret missing from the vault is logged and skipped so it can still be
// supplied through the environment.
//
// Everything here logs to stderr: in stdio mode stdout carries the MCP protocol.

import dotenv from "dotenv";

// Same call server.js makes, so AZURE_KEY_VAULT_URL (and local secrets) in .env
// are visible here. dotenv never overrides variables that already exist, so the
// values written below survive server.js's own dotenv.config().
dotenv.config({ quiet: true });

const VAULT_URL_VAR = "AZURE_KEY_VAULT_URL";

// env var the server reads -> secret name in kv-ntm-apps.
export const SECRETS = {
  CW_CLIENT_ID: "cw-client-id",
  CW_PUBLIC_KEY: "cw-public-key",
  CW_PRIVATE_KEY: "cw-private-key",
};

const log = (...args) => console.error(...args);

const isNotFound = (err) => err?.statusCode === 404 || err?.code === "SecretNotFound";

const AUTH_ERRORS = new Set([
  "AuthenticationError",
  "AggregateAuthenticationError",
  "CredentialUnavailableError",
  "AuthenticationRequiredError",
]);
const isAuthError = (err) => AUTH_ERRORS.has(err?.name);

async function load() {
  const vaultUrl = (process.env[VAULT_URL_VAR] || "").trim();
  if (!vaultUrl) {
    log(`[vault] ${VAULT_URL_VAR} not set — secrets come from the environment / .env`);
    return [];
  }

  // Loaded lazily so the no-vault path (local stdio) does not pay for the SDK.
  const [{ DefaultAzureCredential }, { SecretClient }] = await Promise.all([
    import("@azure/identity"),
    import("@azure/keyvault-secrets"),
  ]);

  const credential = new DefaultAzureCredential();
  const client = new SecretClient(vaultUrl, credential);

  const results = await Promise.all(
    Object.entries(SECRETS).map(async ([envName, secretName]) => {
      try {
        const { value } = await client.getSecret(secretName);
        return { envName, secretName, value };
      } catch (err) {
        if (isNotFound(err)) return { envName, secretName, missing: true };
        if (isAuthError(err)) {
          throw new Error(
            `[vault] authentication to ${vaultUrl} failed while reading '${secretName}' — ` +
              `check AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET: ${err.message}`,
            { cause: err },
          );
        }
        // network, 403 (role not assigned / firewall), throttling
        throw new Error(`[vault] could not read '${secretName}' from ${vaultUrl}: ${err?.message ?? err}`, {
          cause: err,
        });
      }
    }),
  );

  const loaded = [];
  const missing = [];
  for (const r of results) {
    if (r.missing) {
      missing.push(r.secretName);
    } else if (r.value) {
      process.env[r.envName] = r.value;
      loaded.push(r.envName);
    }
  }

  log(`[vault] loaded ${loaded.length} secret(s) from ${vaultUrl}: ${loaded.join(", ") || "-"}`);
  if (missing.length) log(`[vault] not in vault (environment fallback): ${missing.join(", ")}`);
  return loaded;
}

// Top-level await: server.js's `import "./vault.js"` does not resolve until this
// settles, so its top-level process.env reads see the vault values. A rejection
// here aborts module evaluation and the process exits non-zero.
export const loaded = await load();
