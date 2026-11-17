// Shared by Railway pre-deploy and the isolated integration tests.
export async function checkTenantAdminMfaSchema(pool) {
    const { rows: [mfa] } = await pool.query(`
        select case when to_regprocedure('filesvc.check_dms_mfa_session(uuid,uuid,uuid)') is not null then
            has_function_privilege(current_user, 'filesvc.check_dms_mfa_session(uuid,uuid,uuid)', 'EXECUTE')
            and not has_function_privilege('anon', 'filesvc.check_dms_mfa_session(uuid,uuid,uuid)', 'EXECUTE')
            and not has_function_privilege('authenticated', 'filesvc.check_dms_mfa_session(uuid,uuid,uuid)', 'EXECUTE')
        else false end as ready
    `);
    if (!mfa?.ready) throw Object.assign(new Error('MFA schema is not ready'), { code: 'TENANT_ADMIN_MFA_SCHEMA_REQUIRED' });
    // Also resolve the body: missing Auth columns/owner grants must fail closed.
    await pool.query('select filesvc.check_dms_mfa_session($1, $1, $1)', ['00000000-0000-0000-0000-000000000000']);
    return true;
}
