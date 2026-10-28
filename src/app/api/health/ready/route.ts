import { getDatabasePool } from "@/infrastructure/database/pool";

export async function GET(): Promise<Response> {
  try {
    await getDatabasePool().query("select 1");
    return Response.json({ status: "ready", checks: { database: "ok" } });
  } catch (error) {
    // Keep connection details and credentials out of the HTTP response.
    const databaseError = error as { code?: string; message?: string };
    console.error("Database readiness check failed", {
      code: databaseError.code,
      message: databaseError.message ?? "Unknown database error",
    });

    return Response.json(
      { status: "not_ready", checks: { database: "unavailable" } },
      { status: 503 },
    );
  }
}
