import type { AuthenticatedApplication, DepartmentRole } from "@/application/auth/authenticated-application";

const roleRank: Record<DepartmentRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
};

export function departmentGrant(
  application: AuthenticatedApplication,
  departmentId: string,
) {
  return application.departments.find((department) => department.id === departmentId);
}

export function hasDepartmentRole(
  application: AuthenticatedApplication,
  departmentId: string,
  minimumRole: DepartmentRole,
): boolean {
  const grant = departmentGrant(application, departmentId);
  return !!grant && roleRank[grant.role] >= roleRank[minimumRole];
}

export function accessibleDepartmentIds(application: AuthenticatedApplication): string[] {
  return application.departments.map((department) => department.id);
}

export function departmentIdsForRole(
  application: AuthenticatedApplication,
  minimumRole: DepartmentRole,
): string[] {
  return application.departments
    .filter((department) => roleRank[department.role] >= roleRank[minimumRole])
    .map((department) => department.id);
}

export function canDelegateDepartmentRole(
  application: AuthenticatedApplication,
  departmentId: string,
  targetRole: DepartmentRole,
): boolean {
  const grant = departmentGrant(application, departmentId);
  return !!grant && roleRank[grant.role] >= roleRank[targetRole];
}
