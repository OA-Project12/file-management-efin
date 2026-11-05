import { auditRoute } from "@/infrastructure/audit/audit-route";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { findScopedScan, scanResponse } from "@/infrastructure/database/malware-scan-jobs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code: string, status: number) => Response.json({ error:{code,message:code} },
    { status, headers:{"Cache-Control":"no-store"} });

export const GET = auditRoute("file.scan_status", "file", async (request: Request, context: {params:Promise<{fileId:string;scanId:string}>}) => {
    const actor = await authenticateApplicationKey(request);
    if (!actor) return fail("unauthorized",401);
    if (!actor.scopes.includes("files:write")) return fail("forbidden",403);
    const {fileId,scanId} = await context.params;
    if (!uuid.test(fileId) || !uuid.test(scanId)) return fail("scan_not_found",404);
    const owner = actor.userId ? null : new URL(request.url).searchParams.get("ownerSubject")?.trim();
    if (!actor.userId && (!owner || owner.length>255)) return fail("invalid_owner_subject",400);
    const job = await findScopedScan(actor,fileId,scanId,owner??null);
    return job ? scanResponse(job) : fail("scan_not_found",404);
}, {recordSuccess:false});
