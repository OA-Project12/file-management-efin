import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");

function readOptions(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];

    if (option === "--application-id" && value) {
      options.applicationId = value;
      index += 1;
    } else if (option === "--expires-in-days" && value) {
      options.expiresInDays = Number(value);
      index += 1;
    } else if (option === "--scopes" && value) {
      options.scopes = value.split(",").map((scope) => scope.trim());
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete option: ${option}`);
    }
  }

  if (!options.applicationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.applicationId)) {
    throw new Error("Provide a valid UUID with --application-id.");
  }

  options.expiresInDays ??= 90;
  if (!Number.isInteger(options.expiresInDays) || options.expiresInDays < 1 || options.expiresInDays > 365) {
    throw new Error("--expires-in-days must be an integer from 1 to 365.");
  }

  options.scopes ??= ["files:read", "files:write"];
  const allowedScopes = new Set(["files:read", "files:write", "keys:manage"]);
  if (
    options.scopes.length < 1 ||
    options.scopes.some((scope) => !allowedScopes.has(scope)) ||
    new Set(options.scopes).size !== options.scopes.length
  ) {
    throw new Error("--scopes must be unique values from files:read, files:write, keys:manage.");
  }

  return options;
}

async function main() {
  const { applicationId, expiresInDays, scopes } = readOptions(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is missing. Check .env.local.");
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000,
  });
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("begin");

    const keyPrefix = `fsvc_${randomBytes(6).toString("hex")}`;
    const secret = randomBytes(32).toString("base64url");
    const secretHash = createHash("sha256").update(secret, "utf8").digest();

    const result = await client.query(
      `
        insert into filesvc.application_keys (
          tenant_id,
          application_id,
          key_prefix,
          secret_hash,
          scopes,
          expires_at
        )
        select
          a.tenant_id,
          a.id,
          $2,
          $3,
          $4::text[],
          now() + ($5::int * interval '1 day')
        from filesvc.applications a
        join filesvc.tenants t on t.id = a.tenant_id
        where a.id = $1
          and a.status = 'active'
          and t.status = 'active'
        returning id, tenant_id, application_id, key_prefix, scopes, expires_at
      `,
      [applicationId, keyPrefix, secretHash, scopes, expiresInDays],
    );

    if (result.rowCount !== 1) {
      throw new Error("No active application matched that ID. No key was created.");
    }

    await client.query("commit");
    committed = true;

    const created = result.rows[0];
    console.log("Application key created. Copy the secret now; it cannot be retrieved later.");
    console.log(`Key ID: ${created.id}`);
    console.log(`Tenant ID: ${created.tenant_id}`);
    console.log(`Application ID: ${created.application_id}`);
    console.log(`Scopes: ${created.scopes.join(", ")}`);
    console.log(`Expires: ${new Date(created.expires_at).toISOString()}`);
    console.log(`API key: ${keyPrefix}.${secret}`);
  } catch (error) {
    if (!committed) {
      await client.query("rollback").catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  const databaseCode = typeof error?.code === "string" ? ` (${error.code})` : "";
  console.error(`Application key creation failed${databaseCode}: ${error.message}`);
  process.exitCode = 1;
});
