import { logger } from "@/infrastructure/security/logger.mjs";
import { auditRoute } from "@/infrastructure/audit/audit-route";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { ManageDepartmentQuotas,canManageStorageQuota } from "@/application/storage/manage-department-quotas";
import { PostgresDepartmentQuotaRepository } from "@/infrastructure/database/postgres-department-quota-repository";
import { storageQuotaErrorResponse } from "@/infrastructure/http/storage-quota-errors";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code:string,message:string,status:number)=>Response.json({error:{code,message}},{status,headers:{'Cache-Control':'no-store'}});
async function handlePATCH(request:Request,{params}:{params:Promise<{departmentId:string}>}):Promise<Response> {
    try {
        const app=await authenticateApplicationKey(request);
        if(!app)return fail('unauthorized','A valid user session is required.',401);
        if(!canManageStorageQuota(app))return fail('department_quota_forbidden','Tenant Admin user access is required.',403);
        const {departmentId}=await params;
        if(!UUID.test(departmentId))return fail('invalid_department_id','departmentId must be a UUID.',400);
        let body:unknown;try{body=await request.json();}catch{return fail('invalid_json','Request body must be valid JSON.',400);}
        if(!body||typeof body!=='object'||Array.isArray(body))return fail('invalid_json','Request body must be a JSON object.',400);
        const input=body as Record<string,unknown>;
        if(Object.keys(input).some(key=>!['limitBytes','expectedRevision'].includes(key))
            ||!(input.limitBytes===null||typeof input.limitBytes==='string')||typeof input.expectedRevision!=='string')
            return fail('invalid_quota_request','Provide only limitBytes (string or null) and expectedRevision (string).',400);
        const data=await new ManageDepartmentQuotas(new PostgresDepartmentQuotaRepository()).setLimit(app,departmentId,input.limitBytes,input.expectedRevision);
        return Response.json({data},{headers:{'Cache-Control':'no-store'}});
    }catch(error){
        const response=storageQuotaErrorResponse(error);if(response)return response;
        logger.error('Could not set storage quota');return fail('service_unavailable','Could not set storage quota.',503);
    }
}
export const PATCH=auditRoute('department.quota_update','department',handlePATCH,{recordSuccess:false});
