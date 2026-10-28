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
  });

  globalForDatabase.fileStoragePool = pool;
  return pool;
}
