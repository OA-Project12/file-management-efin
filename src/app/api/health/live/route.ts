export async function GET(): Promise<Response> {
  return Response.json({
    status: "ok",
    service: "file-storage-api",
    timestamp: new Date().toISOString(),
  });
}
