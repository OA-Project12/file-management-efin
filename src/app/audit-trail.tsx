"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { DialogShell } from "@/components/ui/dialog-shell";

type Event = {
    id: string;
    occurredAt: string;
    actorKind: string;
    actorId: string | null;
    action: string;
    outcome: string;
    resourceType: string | null;
    resourceId: string | null;
    requestId: string;
    details: Record<string, unknown>;
};
type Props = { api: (path: string) => Promise<unknown> };
type AuditFilters = { action: string; outcome: string; actorId: string; resourceId: string; from: string; to: string };
const emptyFilters: AuditFilters = { action: "", outcome: "", actorId: "", resourceId: "", from: "", to: "" };

export function AuditTrail({ api }: Props) {
    const [items, setItems] = useState<Event[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [action, setAction] = useState("");
    const [outcome, setOutcome] = useState("");
    const [actorId, setActorId] = useState("");
    const [resourceId, setResourceId] = useState("");
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const [loading, setLoading] = useState(false);
    const [filters, setFilters] = useState<AuditFilters>(emptyFilters);
    const [error, setError] = useState("");
    const [selected, setSelected] = useState<Event | null>(null);

    const load = useCallback(
        async (next?: string) => {
            setLoading(true);
            setError("");
            try {
                const query = new URLSearchParams({ limit: "25" });
                if (filters.action.trim()) query.set("action", filters.action.trim());
                if (filters.outcome) query.set("outcome", filters.outcome);
                if (filters.actorId.trim()) query.set("actorId", filters.actorId.trim());
                if (filters.resourceId.trim()) query.set("resourceId", filters.resourceId.trim());
                if (filters.from) query.set("from", new Date(filters.from).toISOString());
                if (filters.to) query.set("to", new Date(filters.to).toISOString());
                if (next) query.set("cursor", next);
                const response = (await api(`/audit-events?${query}`)) as { data: { items: Event[]; nextCursor: string | null } };
                setItems((previous) => (next ? [...previous, ...response.data.items] : response.data.items));
                setCursor(response.data.nextCursor);
            } catch (error) {
                setError(error instanceof Error ? error.message : "โหลดประวัติไม่สำเร็จ");
            } finally {
                setLoading(false);
            }
        },
        [api, filters],
    );

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void load();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [load]);

    return (
        <div className="audit-panel">
            <div className="heading">
                <div>
                    <h1>ประวัติการใช้งาน</h1>
                    <p>เหตุการณ์ของ tenant นี้ย้อนหลังสูงสุด 365 วัน</p>
                </div>
                <button className="secondary" onClick={() => void load()}>
                    <RefreshCw size={17} aria-hidden="true" /> โหลดใหม่
                </button>
            </div>
            <form className="audit-filters" onSubmit={(event) => { event.preventDefault(); if (from && to && from > to) { setError("เวลาเริ่มต้นต้องไม่เกินเวลาสิ้นสุด"); return; } setFilters({ action, outcome, actorId, resourceId, from, to }); }}>
                <input
                    aria-label="การกระทำ"
                    placeholder="การกระทำ เช่น file.download_url"
                    value={action}
                    onChange={(event) => setAction(event.target.value)}
                />
                <select aria-label="ผลลัพธ์" value={outcome} onChange={(event) => setOutcome(event.target.value)}>
                    <option value="">ทุกผลลัพธ์</option>
                    <option value="success">สำเร็จ</option>
                    <option value="denied">ถูกปฏิเสธ</option>
                    <option value="failure">ล้มเหลว</option>
                </select>
                <input
                    aria-label="รหัสผู้กระทำ"
                    placeholder="Actor UUID"
                    value={actorId}
                    onChange={(event) => setActorId(event.target.value)}
                />
                <input
                    aria-label="รหัสทรัพยากร"
                    placeholder="Resource UUID"
                    value={resourceId}
                    onChange={(event) => setResourceId(event.target.value)}
                />
                <label>
                    ตั้งแต่ <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} />
                </label>
                <label>
                    ก่อน <input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} />
                </label>
                <div className="filter-actions"><button type="button" className="secondary" onClick={() => { setAction(""); setOutcome(""); setActorId(""); setResourceId(""); setFrom(""); setTo(""); setFilters({ ...emptyFilters }); }}>ล้างตัวกรอง</button><button className="primary" type="submit">ใช้ตัวกรอง</button></div>
            </form>
            {error && <div className="state-panel error-state" role="alert"><h2>โหลดประวัติไม่สำเร็จ</h2><p>{error}</p><button className="secondary" onClick={() => void load()}>ลองใหม่</button></div>}
            <div className="table-box stack-table" aria-busy={loading}>
                <table>
                    <thead>
                        <tr>
                            <th>เวลา</th>
                            <th>การกระทำ</th>
                            <th>ผล</th>
                            <th>ผู้กระทำ</th>
                            <th>ทรัพยากร</th>
                            <th>รายละเอียด</th>
                        </tr>
                    </thead>
                    <tbody>
                        {items.map((event) => (
                            <tr key={event.id}>
                                <td data-label="เวลา">{new Date(event.occurredAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}</td>
                                <td data-label="การกระทำ">{event.action}</td>
                                <td data-label="ผล">{event.outcome}</td>
                                <td data-label="ผู้กระทำ" title={event.actorId ?? ""}>
                                    {event.actorKind}: {event.actorId?.slice(0, 8) ?? "—"}
                                </td>
                                <td data-label="ทรัพยากร" title={event.resourceId ?? ""}>
                                    {event.resourceType ?? "—"} {event.resourceId?.slice(0, 8) ?? ""}
                                </td>
                                <td data-label="รายละเอียด"><button className="text-btn" onClick={() => setSelected(event)}>ดูรายละเอียด</button></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {loading && items.length === 0 && <div className="empty" role="status">กำลังโหลดประวัติ…</div>}
                {!loading && !error && items.length === 0 && <div className="empty">ไม่พบเหตุการณ์ตามตัวกรองที่เลือก</div>}
            </div>
            {cursor && (
                <button className="secondary audit-more" disabled={loading} onClick={() => void load(cursor)}>
                    โหลดเพิ่ม
                </button>
            )}
            {selected && <DialogShell open onOpenChange={(open) => { if (!open) setSelected(null); }} title="รายละเอียดเหตุการณ์"><section className="audit-detail"><h2>รายละเอียดเหตุการณ์</h2><p>{selected.action} · {new Date(selected.occurredAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}</p><dl><dt>ผลลัพธ์</dt><dd>{selected.outcome}</dd><dt>ผู้กระทำ</dt><dd>{selected.actorKind}: {selected.actorId ?? "—"}</dd><dt>ทรัพยากร</dt><dd>{selected.resourceType ?? "—"}: {selected.resourceId ?? "—"}</dd><dt>Request ID</dt><dd>{selected.requestId}</dd></dl><h3>ข้อมูลเพิ่มเติม</h3><pre>{JSON.stringify(selected.details, null, 2)}</pre><button className="secondary" onClick={() => setSelected(null)}>ปิด</button></section></DialogShell>}
        </div>
    );
}
