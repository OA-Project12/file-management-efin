import { logger } from "@/infrastructure/security/logger.mjs";
import { getDatabasePool } from "@/infrastructure/database/pool";
import { checkRedisReady, mode } from "@/infrastructure/security/rate-limit.mjs";
import { connection } from "next/server";

export async function GET(): Promise<Response> {
  await connection();
  try {
    await getDatabasePool().query("select 1");
    await checkRedisReady();
    return Response.json({ status: "ready", checks: { database: "ok", security: mode() === "enforce" ? "ok" : "report" } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Keep connection details and credentials out of the HTTP response.
    const databaseError = error as { code?: string; message?: string };
    logger.error("Database readiness check failed", {
      code: databaseError.code,
      message: databaseError.message ?? "Unknown database error",
    });

    return Response.json(
      { status: "not_ready", checks: { dependencies: "unavailable" } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
