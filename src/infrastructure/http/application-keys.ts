import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { ApplicationKeyRecord } from "@/infrastructure/database/postgres-application-key-repository";

export function generateApplicationKey() {
    const keyPrefix = `fsvc_${randomBytes(6).toString("hex")}`;
    const secret = randomBytes(32).toString("base64url");
    return {
        keyPrefix,
        secretHash: createHash("sha256").update(secret, "utf8").digest(),
        apiKey: `${keyPrefix}.${secret}`,
    };
}

export function parseKeyExpiryDays(value: unknown): number | null {
    if (value === undefined) return 90;
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 365 ? value : null;
}

export function presentApplicationKey(record: ApplicationKeyRecord) {
    return {
        id: record.id,
        keyPrefix: record.keyPrefix,
        scopes: record.scopes,
        createdAt: record.createdAt.toISOString(),
        expiresAt: record.expiresAt?.toISOString() ?? null,
        revokedAt: record.revokedAt?.toISOString() ?? null,
        lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
        rotatedFromKeyId: record.rotatedFromKeyId,
        departmentGrants: record.departmentGrants,
    };
}
