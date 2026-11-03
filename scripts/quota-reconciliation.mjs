import { createHash, randomUUID } from "node:crypto";
import { isMissingStorageObject } from "./worker-storage.mjs";

const MAX = 9223372036854775807n;
export function bytes(value) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("invalid_storage_size");
    const text = String(value);
    if (!/^(0|[1-9][0-9]*)$/.test(text) || BigInt(text) > MAX) throw new Error("invalid_storage_size");
    return text;
}
export const objectId = (o) => JSON.stringify([o.bucket_id, o.object_key]);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const columns = {
    departments: "id,tenant_id,application_id,status",
    quotas: "department_id,limit_bytes::text,used_bytes::text,reserved_bytes::text,revision::text,initialized_at",
    files: "id,department_id,bucket_id,object_key,size_bytes::text,status,trashed_at,current_version_id,updated_at",
    versions: "v.id,v.file_id,v.bucket_id,v.object_key,v.size_bytes::text,v.status,v.completed_at",
    allocations:
        "a.id,a.department_id,a.file_id,a.version_id,a.kind,a.bucket_id,a.object_key,a.state,a.reserved_bytes::text,a.charged_bytes::text,a.object_size_bytes::text,a.expires_at,a.released_at,a.updated_at",
};
// One SQL statement gives a consistent snapshot. No fingerprints or credentials.
export async function readQuotaSnapshot(db, scope) {
    const where = "tenant_id=$1 and application_id=$2";
    const datasets = {
        departments: `select ${columns.departments} from filesvc.departments where ${where} order by id`,
        quotas: `select ${columns.quotas} from filesvc.department_storage_quotas where ${where} order by department_id`,
        files: `select ${columns.files} from filesvc.files where ${where} order by id`,
        versions: `select ${columns.versions} from filesvc.file_versions v join filesvc.files f on f.id=v.file_id where f.${where.replace(" and ", " and f.")} order by v.id`,
        uploads: `select i.file_id,i.expires_at,i.completed_at from filesvc.upload_intents i join filesvc.files f on f.id=i.file_id where f.${where.replace(" and ", " and f.")} order by i.file_id`,
        versionUploads: `select i.file_id,i.version_id,i.expires_at,i.completed_at from filesvc.version_upload_intents i join filesvc.files f on f.id=i.file_id where f.${where.replace(" and ", " and f.")} order by i.version_id`,
        restores: `select i.file_id,i.version_id,i.expires_at,i.completed_at from filesvc.version_restore_intents i join filesvc.files f on f.id=i.file_id where f.${where.replace(" and ", " and f.")} order by i.version_id`,
        allocations: `select ${columns.allocations} from filesvc.storage_allocations a where a.${where.replace(" and ", " and a.")} order by a.id`,
        cleanup: `select resource_id as file_id,details->>'versionId' as version_id,details->>'kind' as kind from filesvc.audit_log where ${where} and action='file.cleanup_completed' and outcome='success' order by resource_id,details::text`,
    };
    const fields = Object.entries(datasets).map(
        ([name, query]) => `'${name}',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (${query}) x)`,
    );
    return (await db.query(`select jsonb_build_object(${fields.join(",")}) as snapshot`, [scope.tenantId, scope.applicationId])).rows[0]
        .snapshot;
}
export function departmentFingerprint(snapshot, id) {
    const files = snapshot.files.filter((f) => f.department_id === id),
        ids = new Set(files.map((f) => f.id));
    return digest({
        department: snapshot.departments.filter((d) => d.id === id),
        quota: snapshot.quotas.filter((q) => q.department_id === id),
        files,
        versions: snapshot.versions.filter((v) => ids.has(v.file_id)),
        uploads: snapshot.uploads.filter((v) => ids.has(v.file_id)),
        versionUploads: snapshot.versionUploads.filter((v) => ids.has(v.file_id)),
        restores: snapshot.restores.filter((v) => ids.has(v.file_id)),
        allocations: snapshot.allocations.filter((a) => a.department_id === id || ids.has(a.file_id)),
        cleanup: snapshot.cleanup.filter((v) => ids.has(v.file_id)),
    });
}

export function storageInspector(storage, configuredBucket) {
    return {
        async info(bucket, key) {
            const { data, error } = await storage.storage.from(bucket).info(key);
            if (error) {
                if (isMissingStorageObject(error)) return null;
                throw new Error("storage_inspection_failed");
            }
            if (!data) throw new Error("storage_inspection_empty_response");
            return { size: bytes(data.size) };
        },
        async inventory(scope, buckets) {
            const result = [];
            for (const bucket of [...new Set([configuredBucket, ...buckets])].filter(Boolean)) {
                const queue = [`${scope.tenantId}/${scope.applicationId}`];
                while (queue.length) {
                    const prefix = queue.shift();
                    let offset = 0;
                    while (true) {
                        const { data, error } = await storage.storage
                            .from(bucket)
                            .list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
                        if (error || !Array.isArray(data)) throw new Error("storage_inventory_failed");
                        for (const entry of data) {
                            if (!entry.name || entry.name.includes("/")) throw new Error("invalid_storage_inventory");
                            const key = `${prefix}/${entry.name}`;
                            if (entry.id === null) queue.push(key);
                            else result.push({ bucket_id: bucket, object_key: key });
                        }
                        if (data.length < 1000) break;
                        offset += data.length;
                    }
                }
            }
            return result.sort((a, b) => objectId(a).localeCompare(objectId(b)));
        },
    };
}

// Build only a proposal; this function never writes database or Storage state.
export async function inspectQuota(snapshot, scope, inspector, { mode = "backfill", departmentId } = {}) {
    const fileMap = new Map(snapshot.files.map((f) => [f.id, f]));
    const refs = new Map(),
        globalIssues = [],
        results = new Map();
    for (const d of snapshot.departments)
        results.set(d.id, {
            departmentId: d.id,
            before: snapshot.quotas.find((q) => q.department_id === d.id) ?? null,
            fingerprint: departmentFingerprint(snapshot, d.id),
            issues: [],
            proposals: [],
            usedBytes: "0",
            reservedBytes: "0",
        });
    const issue = (dept, code, object) => {
        const dest = results.get(dept)?.issues ?? globalIssues;
        dest.push({ code, ...(object ? { bucketId: object.bucket_id, objectKey: object.object_key } : {}) });
    };
    const add = (f, row, version = null) => {
        const key = objectId(row);
        let ref = refs.get(key);
        if (ref && ref.file.id !== f.id) {
            issue(f.department_id, "object_referenced_by_multiple_files", row);
            issue(ref.file.department_id, "object_referenced_by_multiple_files", row);
            return;
        }
        if (!ref) {
            ref = { file: f, bucket_id: row.bucket_id, object_key: row.object_key, rows: [], version: null };
            refs.set(key, ref);
        }
        ref.rows.push(row);
        if (version) {
            if (ref.version && ref.version.id !== version.id) issue(f.department_id, "object_referenced_by_multiple_versions", row);
            ref.version = version;
        }
    };
    for (const f of snapshot.files) add(f, f);
    for (const v of snapshot.versions) {
        const f = fileMap.get(v.file_id);
        if (f) add(f, v, v);
    }
    for (const a of snapshot.allocations) {
        const ref = refs.get(objectId(a));
        if (!ref || ref.file.id !== a.file_id) issue(a.department_id, "allocation_without_reference", a);
        else if (a.state !== "released" && a.department_id !== ref.file.department_id) {
            issue(a.department_id, "allocation_department_mismatch", a);
            issue(ref.file.department_id, "allocation_department_mismatch", a);
        }
    }
    let inventory = [];
    try {
        inventory = await inspector.inventory(
            scope,
            [...refs.values()].map((r) => r.bucket_id),
        );
    } catch {
        globalIssues.push({ code: "storage_inventory_failed" });
    }
    const prefix = `${scope.tenantId}/${scope.applicationId}/`;
    for (const object of inventory)
        if (!refs.has(objectId(object))) {
            const id = object.object_key.startsWith(prefix) ? object.object_key.slice(prefix.length).split("/")[0] : null;
            issue(fileMap.get(id)?.department_id, "unreferenced_storage_object", object);
        }
    for (const ref of refs.values()) {
        const { file: f, version: v } = ref,
            result = results.get(f.department_id);
        if (!result) {
            issue(null, "file_department_not_found", ref);
            continue;
        }
        const old = snapshot.allocations.find((a) => objectId(a) === objectId(ref));
        const expectedKey = `${scope.tenantId}/${scope.applicationId}/${f.id}`;
        if (ref.object_key !== expectedKey && (!v || ref.object_key !== `${expectedKey}/versions/${v.id}`)) {
            issue(f.department_id, "unexpected_object_key", ref);
            continue;
        }
        let observed;
        try {
            observed = await inspector.info(ref.bucket_id, ref.object_key);
            if (observed) observed = { size: bytes(observed.size) };
        } catch {
            issue(f.department_id, "storage_inspection_failed", ref);
            continue;
        }
        const purged = f.status === "deleted" && f.trashed_at === null;
        const cleaned = snapshot.cleanup.some((c) => c.file_id === f.id && (c.version_id ?? null) === (v?.id ?? null));
        // Successful v1 rows can coexist with a completed initial intent; they
        // are stored objects, never pending reservations.
        const initialIntent = ref.object_key === expectedKey ? snapshot.uploads.find((i) => i.file_id === f.id) : null;
        const intent = v
            ? (snapshot.restores.find((i) => i.version_id === v.id) ??
              snapshot.versionUploads.find((i) => i.version_id === v.id) ??
              initialIntent)
            : initialIntent;
        const available = v ? v.status === "available" : f.status === "available" || f.trashed_at !== null;
        let proposal;
        const base = {
            file_id: f.id,
            department_id: f.department_id,
            version_id: v?.id ?? null,
            bucket_id: ref.bucket_id,
            object_key: ref.object_key,
            kind:
                old?.kind ??
                (intent
                    ? intent === initialIntent
                        ? "initial_upload"
                        : snapshot.restores.some((i) => i.version_id === v?.id)
                          ? "version_restore"
                          : "version_upload"
                    : "legacy"),
            expires_at: old?.expires_at ?? intent?.expires_at ?? null,
        };
        if (purged || cleaned || old?.state === "released") {
            if (intent && new Date(intent.expires_at).getTime() > Date.now()) {
                issue(f.department_id, "released_object_has_active_grant", ref);
                continue;
            }
            if (observed) {
                issue(f.department_id, "released_object_still_present", ref);
                continue;
            }
            if (!purged && !cleaned && available) {
                issue(f.department_id, "available_object_marked_released", ref);
                continue;
            }
            proposal = {
                ...base,
                department_id: old?.department_id ?? f.department_id,
                state: "released",
                reserved_bytes: "0",
                charged_bytes: "0",
                object_size_bytes: old?.object_size_bytes ?? null,
                released_at: old?.released_at ?? f.updated_at,
            };
        } else if (available) {
            if (!observed) {
                issue(f.department_id, "available_object_missing", ref);
                continue;
            }
            if (ref.rows.some((row) => bytes(row.size_bytes) !== observed.size)) {
                issue(f.department_id, "object_size_mismatch", ref);
                continue;
            }
            proposal = {
                ...base,
                state: "stored",
                reserved_bytes: "0",
                charged_bytes: observed.size,
                object_size_bytes: observed.size,
                released_at: null,
            };
        } else if (old) {
            // Deletion may have happened before the worker's DB commit. Keep
            // the existing debt until its receipt transaction releases it.
            proposal = {
                ...base,
                state: old.state,
                reserved_bytes: old.reserved_bytes,
                charged_bytes: old.charged_bytes,
                object_size_bytes: old.object_size_bytes,
                released_at: null,
            };
            if (observed && BigInt(old.charged_bytes) > 0n && observed.size !== old.object_size_bytes)
                issue(f.department_id, "allocation_size_mismatch", ref);
            if (observed && old.state === "reserved" && BigInt(observed.size) > BigInt(old.reserved_bytes))
                issue(f.department_id, "pending_object_exceeds_reservation", ref);
        } else if (intent && intent.completed_at === null) {
            const amount = bytes((v ?? f).size_bytes);
            if (amount === "0") {
                issue(f.department_id, "invalid_reservation_size", ref);
                continue;
            }
            const pending = (v ?? f).status === "pending_upload";
            if (pending) {
                proposal = {
                    ...base,
                    state: "reserved",
                    reserved_bytes: amount,
                    charged_bytes: "0",
                    object_size_bytes: null,
                    released_at: null,
                };
                if (observed && BigInt(observed.size) > BigInt(amount)) issue(f.department_id, "pending_object_exceeds_reservation", ref);
            } else if (observed)
                proposal = {
                    ...base,
                    state: "release_pending",
                    reserved_bytes: "0",
                    charged_bytes: observed.size,
                    object_size_bytes: observed.size,
                    released_at: null,
                };
            else
                proposal = {
                    ...base,
                    state: "release_pending",
                    reserved_bytes: amount,
                    charged_bytes: "0",
                    object_size_bytes: null,
                    released_at: null,
                };
        } else {
            issue(f.department_id, "unaccounted_terminal_object", ref);
            continue;
        }
        if (old) {
            for (const key of ["state", "reserved_bytes", "charged_bytes", "object_size_bytes", "version_id"])
                if ((old[key] ?? null) !== (proposal[key] ?? null)) {
                    issue(f.department_id, "allocation_ledger_mismatch", ref);
                    break;
                }
        } else if (mode === "reconcile") issue(f.department_id, "allocation_missing", ref);
        result.proposals.push({ ...proposal, existingId: old?.id ?? null });
        // Released history may belong to an earlier department; it is zero debt.
        result.usedBytes = (BigInt(result.usedBytes) + BigInt(proposal.charged_bytes)).toString();
        result.reservedBytes = (BigInt(result.reservedBytes) + BigInt(proposal.reserved_bytes)).toString();
    }
    for (const result of results.values()) {
        if (!result.before) result.issues.push({ code: "quota_row_missing" });
        if (BigInt(result.usedBytes) > MAX || BigInt(result.reservedBytes) > MAX) result.issues.push({ code: "quota_total_overflow" });
        result.counterDrift = Boolean(
            result.before && (result.before.used_bytes !== result.usedBytes || result.before.reserved_bytes !== result.reservedBytes),
        );
        result.canApply = globalIssues.length === 0 && result.issues.length === 0;
    }
    return {
        scope,
        mode,
        globalIssues,
        inventoryFingerprint: digest(inventory),
        departments: [...results.values()].filter((d) => !departmentId || d.departmentId === departmentId),
    };
}

export async function applyQuotaDepartment(pool, scope, snapshot, department, { mode = "backfill", runId = randomUUID() } = {}) {
    if (!department.canApply) throw new Error("quota_department_blocked");
    const client = await pool.connect();
    try {
        await client.query("begin");
        await client.query("set local lock_timeout='5s'");
        await client.query(
            `select id from filesvc.files where tenant_id=$1 and application_id=$2 and department_id=$3 order by id for update`,
            [scope.tenantId, scope.applicationId, department.departmentId],
        );
        await client.query(
            `select department_id from filesvc.department_storage_quotas where tenant_id=$1 and application_id=$2 and department_id=$3 for update`,
            [scope.tenantId, scope.applicationId, department.departmentId],
        );
        const current = await readQuotaSnapshot(client, scope);
        if (
            departmentFingerprint(current, department.departmentId) !== department.fingerprint ||
            departmentFingerprint(snapshot, department.departmentId) !== department.fingerprint
        )
            throw new Error("quota_snapshot_changed");
        const missing = department.proposals.filter((p) => !p.existingId);
        if (mode === "reconcile" && missing.length) throw new Error("allocation_missing");
        for (const p of missing)
            await client.query(
                `insert into filesvc.storage_allocations
          (tenant_id,application_id,department_id,file_id,version_id,kind,bucket_id,object_key,state,reserved_bytes,charged_bytes,object_size_bytes,expires_at,released_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::bigint,$11::bigint,$12::bigint,$13,$14)`,
                [
                    scope.tenantId,
                    scope.applicationId,
                    p.department_id,
                    p.file_id,
                    p.version_id,
                    p.kind,
                    p.bucket_id,
                    p.object_key,
                    p.state,
                    p.reserved_bytes,
                    p.charged_bytes,
                    p.object_size_bytes,
                    p.expires_at,
                    p.released_at,
                ],
            );
        const changed = missing.length > 0 || department.counterDrift || !department.before.initialized_at;
        if (changed) {
            await client.query(
                `update filesvc.department_storage_quotas set used_bytes=$4::bigint,reserved_bytes=$5::bigint,
              initialized_at=coalesce(initialized_at,now()),revision=revision+1,updated_at=now()
              where tenant_id=$1 and application_id=$2 and department_id=$3`,
                [scope.tenantId, scope.applicationId, department.departmentId, department.usedBytes, department.reservedBytes],
            );
            await client.query(
                `insert into filesvc.audit_log
              (tenant_id,application_id,actor_kind,action,outcome,resource_type,resource_id,request_id,details)
              values ($1,$2,'worker',$3,'success','department',$4,$5,$6::jsonb)`,
                [
                    scope.tenantId,
                    scope.applicationId,
                    `storage.quota_${mode === "backfill" ? "backfilled" : "reconciled"}`,
                    department.departmentId,
                    runId,
                    JSON.stringify({
                        beforeUsedBytes: department.before.used_bytes,
                        beforeReservedBytes: department.before.reserved_bytes,
                        usedBytes: department.usedBytes,
                        reservedBytes: department.reservedBytes,
                        allocationsAdded: missing.length,
                    }),
                ],
            );
        }
        await client.query("commit");
        return changed ? "applied" : "unchanged";
    } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}
