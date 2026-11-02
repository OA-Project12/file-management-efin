import { quotaBytes } from "./department-quota";

export type QuotaUnit = "bytes" | "MB" | "GB";
const units = { bytes: BigInt(1), MB: BigInt(1000000), GB: BigInt(1000000000) };
const places = { bytes: 0, MB: 6, GB: 9 };
export function parseQuotaAmount(value: string, unit: QuotaUnit): string {
    const input = value.trim();
    if (input.length > 40 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(input))
        throw new Error("กรอกจำนวนตั้งแต่ 0 ขึ้นไป ใช้จุดทศนิยมและไม่ใส่เครื่องหมายคั่นหลัก");
    const [whole, fraction = ""] = input.split(".");
    if (fraction.length > places[unit]) throw new Error(`หน่วย ${unit} รองรับทศนิยมได้ไม่เกิน ${places[unit]} ตำแหน่ง`);
    const result = (BigInt(whole) * units[unit] + BigInt(fraction.padEnd(places[unit], "0") || "0")).toString();
    try {
        quotaBytes(result);
    } catch {
        throw new Error("จำนวนพื้นที่เกินค่าสูงสุดที่ระบบรองรับ");
    }
    return result;
}
export function exactQuotaAmount(value: string, unit: QuotaUnit): string {
    const amount = quotaBytes(value),
        factor = units[unit];
    const remainder = amount % factor;
    return `${amount / factor}${remainder ? "." + remainder.toString().padStart(places[unit], "0").replace(/0+$/, "") : ""}`;
}
export function formatQuotaBytes(value: string | null): string {
    if (value === null) return "—";
    // used + reserved can exceed one int8 even though each counter fits int8.
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid_quota_bytes");
    const amount = BigInt(value),
        names = ["bytes", "KB", "MB", "GB", "TB", "PB", "EB"];
    let factor = BigInt(1),
        index = 0;
    while (index < names.length - 1 && amount >= factor * BigInt(1000)) {
        factor *= BigInt(1000);
        index++;
    }
    if (index === 0) return `${amount.toLocaleString("en-US")} bytes`;
    const scaled = (amount * BigInt(100) + factor / BigInt(2)) / factor;
    return `${(scaled / BigInt(100)).toLocaleString("en-US")}.${(scaled % BigInt(100)).toString().padStart(2, "0")} ${names[index]}`;
}
export function quotaCapacityStatus(item: { accountingStatus: string; limitBytes: string | null; committedBytes: string | null }) {
    if (item.accountingStatus !== "ready") return { label: "รอตรวจสอบยอดพื้นที่", kind: "pending" };
    if (item.limitBytes === null) return { label: "ไม่จำกัด", kind: "unlimited" };
    const committed = BigInt(item.committedBytes ?? "0"),
        limit = BigInt(item.limitBytes);
    if (committed > limit) return { label: "เกินโควตา", kind: "over" };
    if (committed === limit) return { label: "เต็ม", kind: "full" };
    if (committed * BigInt(100) >= limit * BigInt(80)) return { label: "ใกล้เต็ม", kind: "warning" };
    return { label: "ปกติ", kind: "normal" };
}
