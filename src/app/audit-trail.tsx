"use client";

import { useCallback, useEffect, useState } from "react";

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
type Props = { api: (path: string) => Promise<unknown>; onNotice: (message: string) => void };

export function AuditTrail({ api, onNotice }: Props) {
    const [items, setItems] = useState<Event[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [action, setAction] = useState("");
    const [outcome, setOutcome] = useState("");
    const [actorId, setActorId] = useState("");
    const [resourceId, setResourceId] = useState("");
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const [loading, setLoading] = useState(false);

    const load = useCallback(
        async (next?: string) => {
            setLoading(true);
            try {
                const query = new URLSearchParams({ limit: "25" });
                if (action.trim()) query.set("action", action.trim());
                if (outcome) query.set("outcome", outcome);
                if (actorId.trim()) query.set("actorId", actorId.trim());
                if (resourceId.trim()) query.set("resourceId", resourceId.trim());
                if (from) query.set("from", new Date(from).toISOString());
                if (to) query.set("to", new Date(to).toISOString());
                if (next) query.set("cursor", next);
                const response = (await api(`/audit-events?${query}`)) as { data: { items: Event[]; nextCursor: string | null } };
                setItems((previous) => (next ? [...previous, ...response.data.items] : response.data.items));
                setCursor(response.data.nextCursor);
            } catch (error) {
                onNotice(error instanceof Error ? error.message : "โหลดประวัติไม่สำเร็จ");
            } finally {
                setLoading(false);
            }
        },
        [api, action, outcome, actorId, resourceId, from, to, onNotice],
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
                    ↻ โหลดใหม่
                </button>
            </div>
            <div className="audit-filters">
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
            </div>
            <div className="table-box">
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
                                <td>{new Date(event.occurredAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}</td>
                                <td>{event.action}</td>
                                <td>{event.outcome}</td>
                                <td title={event.actorId ?? ""}>
                                    {event.actorKind}: {event.actorId?.slice(0, 8) ?? "—"}
                                </td>
                                <td title={event.resourceId ?? ""}>
                                    {event.resourceType ?? "—"} {event.resourceId?.slice(0, 8) ?? ""}
                                </td>
                                <td>
                                    <code>{JSON.stringify(event.details)}</code>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {!loading && items.length === 0 && <div className="empty">ไม่พบเหตุการณ์</div>}
            </div>
            {cursor && (
                <button className="secondary audit-more" disabled={loading} onClick={() => void load(cursor)}>
                    โหลดเพิ่ม
                </button>
            )}
        </div>
    );
}
