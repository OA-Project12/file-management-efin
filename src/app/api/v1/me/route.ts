import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";

export async function GET(request: Request): Promise<Response> {
  try {
    const application = await authenticateApplicationKey(request);

    if (!application) {
      return Response.json(
        { error: { code: "unauthorized", message: "A valid API key is required." } },
        {
          status: 401,
          headers: {
            "Cache-Control": "no-store",
            "WWW-Authenticate": 'Bearer realm="file-storage"',
          },
        },
      );
    }

    return Response.json(
      {
        authenticated: true,
        tenantId: application.tenantId,
        applicationId: application.applicationId,
        scopes: application.scopes,
        departments: application.departments,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const databaseError = error as { code?: string; message?: string };
    console.error("Application key authentication failed", {
      code: databaseError.code,
      message: databaseError.message ?? "Unknown authentication error",
    });

    return Response.json(
      { error: { code: "service_unavailable", message: "Authentication is temporarily unavailable." } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
