import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export function maintenancePaths() {
    const root = path.resolve(process.env.STORAGE_QUOTA_CONTROL_DIR || ".quota-reports");
    return { root, lock: path.join(root, "maintenance.lock"), active: path.join(root, "active") };
}
export function storageMaintenanceEnabled() {
    return process.env.STORAGE_QUOTA_MAINTENANCE === "1" || existsSync(maintenancePaths().lock);
}
// Register before checking the lock again: maintenance either sees this lease or
// this request sees maintenance. Never expire a live process's in-flight work.
export function enterStorageMutation() {
    if (storageMaintenanceEnabled()) return null;
    const { active } = maintenancePaths();
    mkdirSync(active, { recursive: true });
    const file = path.join(active, `${process.pid}-${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: "wx" });
    const release = () => {
        try {
            unlinkSync(file);
        } catch (e) {
            if (e.code !== "ENOENT") throw e;
        }
    };
    if (storageMaintenanceEnabled()) {
        release();
        return null;
    }
    return release;
}
export async function acquireStorageMaintenance(timeoutMs = 120_000) {
    const paths = maintenancePaths();
    mkdirSync(paths.root, { recursive: true });
    const owner = randomUUID();
    writeFileSync(paths.lock, JSON.stringify({ owner, pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
    const release = () => {
        if (JSON.parse(readFileSync(paths.lock, "utf8")).owner !== owner) throw new Error("maintenance_owner_changed");
        unlinkSync(paths.lock);
    };
    try {
        const start = Date.now();
        while (true) {
            let busy = false;
            for (const name of existsSync(paths.active) ? readdirSync(paths.active) : []) {
                const file = path.join(paths.active, name);
                let lease;
                try {
                    lease = JSON.parse(readFileSync(file, "utf8"));
                } catch (e) {
                    if (e.code === "ENOENT") continue;
                    throw e;
                }
                if (!Number.isSafeInteger(lease.pid) || lease.pid <= 0) throw new Error("invalid_mutation_lease");
                try {
                    process.kill(lease.pid, 0);
                    busy = true;
                } catch (e) {
                    if (e.code === "ESRCH") {
                        try {
                            unlinkSync(file);
                        } catch (err) {
                            if (err.code !== "ENOENT") throw err;
                        }
                    } else busy = true;
                }
            }
            if (!busy) return release;
            if (Date.now() - start >= timeoutMs) throw new Error("maintenance_drain_timeout");
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    } catch (error) {
        release();
        throw error;
    }
}

export function isStorageMutation(action) {
    return (
        (action.startsWith("file.") &&
            ![
                "file.search",
                "file.trash_list",
                "file.versions_read",
                "file.scan_status",
                "file.preview_url",
                "file.download_url",
                "file.version_preview_url",
                "file.version_download_url",
            ].includes(action)) ||
        ["folder.create", "folder.access_update", "department.create", "department.quota_update"].includes(action)
    );
}
