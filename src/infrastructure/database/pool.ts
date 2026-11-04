import "server-only";
import { Pool } from "pg";

const globalForDatabase = globalThis as typeof globalThis & {
  fileStoragePool?: Pool;
};

export function getDatabasePool(): Pool {
  if (globalForDatabase.fileStoragePool) {
    return globalForDatabase.fileStoragePool;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured.");
  }

  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // pg-pool awaits onConnect before lending the connection. SET works through
    // Session Pooler without requiring support for extra startup parameters.
    onConnect: async (client) => {
      const initialization = {
        text: "SET statement_timeout = '15s'; SET lock_timeout = '5s'",
        query_timeout: 5_000,
      };
      await client.query(initialization);
    },
  });

  globalForDatabase.fileStoragePool = pool;
  return pool;
}
