export interface AuthenticatedApplication {
    keyId: string;
    tenantId: string;
    applicationId: string;
    scopes: string[];
    departments: DepartmentGrant[];
    userId?: string;
    isTenantAdmin?: boolean;
}

export type DepartmentRole = "admin" | "editor" | "viewer";

export interface DepartmentGrant {
    id: string;
    code: string;
    name: string;
    role: DepartmentRole;
}
