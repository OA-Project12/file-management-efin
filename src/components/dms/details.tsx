"use client";
import { useCallback, useRef, useState, type FormEvent } from "react";
import { Download, FileText, FolderInput, Pencil, Trash2, X } from "lucide-react";
import { Tabs } from "@base-ui/react/tabs";
import { DialogClose, DialogShell } from "@/components/ui/dialog-shell";
import { useFileVersionsView } from "@/app/file-versions";
import { FilePreview } from "./preview";
import { Notice } from "./common";
import { useNavigationGuard, useUnsavedChanges } from "./navigation-guard";
import type { Api, Department, FileRow, Folder } from "./model";
import { canWrite, errorText, fileName, fileSize, isDenied } from "./model";

type Metadata = {
    displayName: string;
    departmentId: string;
    folderId: string;
    tags: string;
};
export function FileDetails({
    file,
    api,
    departments,
    folders,
    preview,
    writeAllowed,
    onClose,
    onRefresh,
    onNotice,
}: {
    file: FileRow;
    api: Api;
    departments: Department[];
    folders: Folder[];
    preview: boolean;
    writeAllowed: boolean;
    onClose: () => void;
    onRefresh: () => void;
    onNotice: (value: string) => void;
}) {
    const { navigate } = useNavigationGuard();
    const [tab, setTab] = useState("details"),
        [editing, setEditing] = useState(false),
        [busy, setBusy] = useState(false),
        [versionBusy, setVersionBusy] = useState(false);
    const [current, setCurrent] = useState(file),
        [error, setError] = useState(""),
        [move, setMove] = useState(false),
        [remove, setRemove] = useState(false),
        [denied, setDenied] = useState(false),
        [downloadLink, setDownloadLink] = useState<string | null>(null);
    const initial: Metadata = {
        displayName: file.displayName || file.originalName || "",
        departmentId: file.departmentId,
        folderId: file.folderId || "",
        tags: file.tags?.join(", ") || "",
    };
    const [draft, setDraft] = useState(initial);
    const [fields, setFields] = useState<{ name?: string; tags?: string }>({});
    const [autoPreview, setAutoPreview] = useState(preview);
    const [previewRevision, setPreviewRevision] = useState(0);
    const onPreviewDenied = useCallback(() => {
        setDenied(true);
        setError("ไม่พบรายการนี้ในขอบเขตที่คุณเข้าถึงได้ กรุณาโหลดรายการใหม่");
        setDownloadLink(null);
    }, []);
    const dirty = editing && JSON.stringify(draft) !== JSON.stringify(initial);
    const errorSummary = useRef<HTMLDivElement>(null),
        submitting = useRef(false);
    const writer = writeAllowed && canWrite(departments.find((d) => d.id === current.departmentId));
    useUnsavedChanges(dirty, busy || versionBusy);
    function fail(cause: unknown) {
        setError(errorText(cause));
        if (isDenied(cause)) {
            setDenied(true);
            setDownloadLink(null);
        }
        requestAnimationFrame(() => errorSummary.current?.focus());
    }
    async function download() {
        if (submitting.current) return;
        submitting.current = true;
        setBusy(true);
        setError("");
        try {
            const result = await api<{ signedUrl: string }>(`/files/${current.id}/download-url`, { method: "POST", body: "{}" });
            setDownloadLink(result.data.signedUrl);
            const target = window.open(result.data.signedUrl, "_blank", "noopener,noreferrer");
            void target;
            onNotice("เริ่มดาวน์โหลดแล้ว หาก browser ไม่เปิด ให้ใช้ลิงก์ดาวน์โหลดในรายละเอียด");
        } catch (cause) {
            fail(cause);
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }
    async function save() {
        if (submitting.current) return;
        submitting.current = true;
        setBusy(true);
        setError("");
        try {
            await api(`/files/${file.id}/metadata`, {
                method: "PATCH",
                body: JSON.stringify({
                    displayName: draft.displayName.trim(),
                    departmentId: draft.departmentId,
                    folderId: draft.departmentId !== file.departmentId ? null : draft.folderId || null,
                    tags: draft.tags
                        .split(",")
                        .map((tag) => tag.trim())
                        .filter(Boolean),
                }),
            });
            setEditing(false);
            setMove(false);
            onNotice("บันทึกข้อมูลแล้ว");
            onClose();
            onRefresh();
        } catch (cause) {
            setMove(false);
            fail(cause);
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }
    function submit(event: FormEvent) {
        event.preventDefault();
        const tags = draft.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);
        const problems: string[] = [];
        if (!draft.displayName.trim() || draft.displayName.trim().length > 255) problems.push("ชื่อแสดงผลต้องมี 1–255 ตัวอักษร");
        if (tags.length > 50 || tags.some((tag) => tag.length > 64)) problems.push("Tags ได้ไม่เกิน 50 ค่า แต่ละค่ายาวไม่เกิน 64 ตัวอักษร");
        if (!canWrite(departments.find((d) => d.id === draft.departmentId)))
            problems.push("ต้องมีสิทธิ์ Editor หรือผู้ดูแลในหน่วยงานปลายทาง");
        const invalidName = !draft.displayName.trim() || draft.displayName.trim().length > 255;
        const invalidTags = tags.length > 50 || tags.some((tag) => tag.length > 64);
        setFields({
            name: invalidName ? "ชื่อแสดงผลต้องมี 1–255 ตัวอักษร" : undefined,
            tags: invalidTags ? "Tags ได้ไม่เกิน 50 ค่า แต่ละค่ายาวไม่เกิน 64 ตัวอักษร" : undefined,
        });
        if (problems.length) {
            setError(problems.join(" · "));
            requestAnimationFrame(() => errorSummary.current?.focus());
            return;
        }
        if (draft.departmentId !== file.departmentId || draft.folderId !== (file.folderId || "")) setMove(true);
        else void save();
    }
    async function trash() {
        if (submitting.current) return;
        submitting.current = true;
        setBusy(true);
        setError("");
        try {
            await api(`/files/${file.id}/delete`, { method: "POST", body: "{}" });
            setRemove(false);
            onClose();
            onNotice("ย้ายไฟล์ไปถังขยะแล้ว ยังใช้พื้นที่จัดเก็บและกู้คืนได้ตามสิทธิ์");
            onRefresh();
        } catch (cause) {
            setRemove(false);
            fail(cause);
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }
    const close = () => navigate(onClose);
    const versionsView = useFileVersionsView({
        enabled: tab === "versions",
        fileId: file.id,
        fileName: fileName(current),
        canEdit: writer,
        api,
        onBusyChange: setVersionBusy,
        onCurrentChanged: (version) => {
            setAutoPreview(false);
            setPreviewRevision((value) => value + 1);
            if (version) setCurrent((old) => ({ ...old, ...version }));
            setDownloadLink(null);
            onRefresh();
        },
    });
    function edit(field: "metadata-name" | "metadata-department") {
        navigate(() => {
            setError("");
            setTab("details");
            setEditing(true);
            requestAnimationFrame(() => document.getElementById(field)?.focus());
        });
    }
    const content = (
        <section className="file-details-content">
            <header className="reader-heading">
                <div className="reader-identity">
                    <FileText aria-hidden="true" />
                    <div>
                        <h2 className="full-name">{fileName(current)}</h2>
                        <p className="muted">
                            {departments.find((department) => department.id === current.departmentId)?.name ?? "หน่วยงาน"}
                        </p>
                    </div>
                </div>
                <div className="reader-actions">
                    {!denied && (
                        <>
                            <button className="primary" disabled={busy || versionBusy} onClick={() => void download()}>
                                <Download aria-hidden="true" /> ดาวน์โหลด
                            </button>
                            {writer && !editing && (
                                <>
                                    <button className="secondary" disabled={busy || versionBusy} onClick={() => edit("metadata-name")}>
                                        <Pencil aria-hidden="true" /> แก้ข้อมูล
                                    </button>
                                    <button
                                        className="secondary"
                                        disabled={busy || versionBusy}
                                        onClick={() => edit("metadata-department")}
                                    >
                                        <FolderInput aria-hidden="true" /> ย้ายไฟล์
                                    </button>
                                    <button className="secondary" disabled={busy || versionBusy} onClick={() => setRemove(true)}>
                                        <Trash2 aria-hidden="true" /> ย้ายไปถังขยะ
                                    </button>
                                </>
                            )}
                        </>
                    )}
                    <button className="icon-button" disabled={busy || versionBusy} aria-label="ปิดรายละเอียดไฟล์" onClick={close}>
                        <X aria-hidden="true" />
                    </button>
                </div>
            </header>
            {error && (
                <div tabIndex={-1} ref={errorSummary}>
                    <Notice tone="danger">
                        {error}
                        {fields.name && (
                            <p>
                                <a href="#metadata-name">แก้ไขชื่อแสดงผล</a>
                            </p>
                        )}
                        {fields.tags && (
                            <p>
                                <a href="#metadata-tags">แก้ไข Tags</a>
                            </p>
                        )}
                    </Notice>
                </div>
            )}
            {!denied && (
                <div className="reader-spread">
                    <div className="reader-preview">
                        {downloadLink && (
                            <p role="status">
                                ลิงก์มีอายุ 5 นาที{" "}
                                <a href={downloadLink} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
                                    ดาวน์โหลด {fileName(current)}
                                </a>
                            </p>
                        )}
                        <FilePreview
                            key={previewRevision}
                            api={api}
                            path={`/files/${current.id}/preview-url`}
                            title={fileName(current)}
                            autoOpen={autoPreview}
                            onDenied={onPreviewDenied}
                        />
                    </div>
                    <div className="reader-inspector">
                        <Tabs.Root
                            value={tab}
                            onValueChange={(value) => {
                                if (versionBusy || busy) return;
                                navigate(() => {
                                    setEditing(false);
                                    setTab(String(value));
                                });
                            }}
                        >
                            <Tabs.List className="file-detail-tabs" aria-label="มุมมองเอกสาร">
                                <Tabs.Tab value="details" disabled={versionBusy}>
                                    รายละเอียด
                                </Tabs.Tab>
                                <Tabs.Tab value="versions" disabled={busy}>
                                    เวอร์ชัน
                                </Tabs.Tab>
                            </Tabs.List>
                            <Tabs.Panel value="details">
                                {!editing ? (
                                    <>
                                        <dl className="metadata-readonly">
                                            <dt>ชื่อแสดงผล</dt>
                                            <dd>{current.displayName ?? current.originalName}</dd>
                                            <dt>ชื่อไฟล์ต้นฉบับ</dt>
                                            <dd>{current.originalName ?? "ยังไม่มีข้อมูล"}</dd>
                                            <dt>ชนิด / ขนาด</dt>
                                            <dd>
                                                {current.contentType} · {fileSize(current.sizeBytes)}
                                            </dd>
                                            <dt>หน่วยงาน</dt>
                                            <dd>{departments.find((d) => d.id === current.departmentId)?.name ?? "ยังไม่มีข้อมูล"}</dd>
                                            <dt>โฟลเดอร์</dt>
                                            <dd>
                                                {current.folderId
                                                    ? (folders.find((f) => f.id === current.folderId)?.name ?? "ยังไม่มีข้อมูลชื่อโฟลเดอร์")
                                                    : "ระดับบนสุดของหน่วยงาน"}
                                            </dd>
                                            <dt>Tags</dt>
                                            <dd className="tags">
                                                {current.tags?.length
                                                    ? current.tags.map((tag) => <span key={tag}>{tag}</span>)
                                                    : "ไม่มี tags"}
                                            </dd>
                                        </dl>
                                    </>
                                ) : (
                                    <form className="metadata" onSubmit={submit} noValidate>
                                        <label htmlFor="metadata-name">
                                            ชื่อแสดงผล
                                            <input
                                                id="metadata-name"
                                                aria-label="ชื่อแสดงผล"
                                                value={draft.displayName}
                                                maxLength={255}
                                                required
                                                aria-invalid={Boolean(fields.name)}
                                                aria-describedby={fields.name ? "metadata-name-error" : undefined}
                                                onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                                            />
                                            {fields.name && (
                                                <small id="metadata-name-error" className="field-error">
                                                    {fields.name}
                                                </small>
                                            )}
                                        </label>
                                        <label htmlFor="metadata-department">
                                            คลังหน่วยงาน
                                            <select
                                                id="metadata-department"
                                                aria-label="คลังหน่วยงาน"
                                                value={draft.departmentId}
                                                onChange={(e) =>
                                                    setDraft({
                                                        ...draft,
                                                        departmentId: e.target.value,
                                                        folderId: e.target.value !== file.departmentId ? "" : file.folderId || "",
                                                    })
                                                }
                                            >
                                                {departments.filter(canWrite).map((d) => (
                                                    <option key={d.id} value={d.id}>
                                                        {d.name}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                        <label htmlFor="metadata-tags">
                                            Tags
                                            <input
                                                id="metadata-tags"
                                                aria-label="Tags"
                                                aria-invalid={Boolean(fields.tags)}
                                                aria-describedby={fields.tags ? "metadata-tags-error" : "metadata-tags-help"}
                                                value={draft.tags}
                                                onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                                            />
                                            <small id="metadata-tags-help">คั่นด้วย comma · ไม่เกิน 50 ค่า ค่าไม่เกิน 64 ตัวอักษร</small>
                                            {fields.tags && (
                                                <small className="field-error" id="metadata-tags-error">
                                                    {fields.tags}
                                                </small>
                                            )}
                                        </label>
                                        <label htmlFor="metadata-folder">
                                            โฟลเดอร์
                                            <select
                                                id="metadata-folder"
                                                aria-label="โฟลเดอร์"
                                                value={draft.folderId}
                                                disabled={draft.departmentId !== file.departmentId}
                                                onChange={(e) => setDraft({ ...draft, folderId: e.target.value })}
                                            >
                                                <option value="">ระดับบนสุดของหน่วยงาน</option>
                                                {file.folderId && !folders.some((f) => f.id === file.folderId) && (
                                                    <option value={file.folderId}>โฟลเดอร์ปัจจุบัน</option>
                                                )}
                                                {folders
                                                    .filter((f) => f.departmentId === draft.departmentId)
                                                    .map((f) => (
                                                        <option key={f.id} value={f.id}>
                                                            {f.name}
                                                        </option>
                                                    ))}
                                            </select>
                                        </label>
                                        <p className="form-help">
                                            การย้ายเปลี่ยนผู้ที่มองเห็นตามสิทธิ์ปลายทาง รวมเวอร์ชันย้อนหลัง
                                            หากเปลี่ยนหน่วยงานจะย้ายไประดับบนสุด
                                        </p>
                                        <div className="dialog-actions">
                                            <button
                                                type="button"
                                                className="secondary"
                                                disabled={busy}
                                                onClick={() =>
                                                    navigate(() => {
                                                        setDraft(initial);
                                                        setEditing(false);
                                                        setError("");
                                                    })
                                                }
                                            >
                                                ยกเลิกแก้ไข
                                            </button>
                                            <button className="primary" disabled={busy}>
                                                {busy ? "กำลังบันทึก…" : "บันทึกข้อมูล"}
                                            </button>
                                        </div>
                                    </form>
                                )}
                            </Tabs.Panel>
                            <Tabs.Panel value="versions">{versionsView}</Tabs.Panel>
                        </Tabs.Root>
                    </div>
                </div>
            )}
            {move && (
                <DialogShell
                    open
                    title="ย้ายเอกสารและเปลี่ยนการมองเห็น?"
                    size="confirm"
                    dirty={false}
                    busy={busy}
                    onOpenChange={(open) => {
                        if (!open) setMove(false);
                    }}
                >
                    <h2>ย้ายเอกสารและเปลี่ยนการมองเห็น?</h2>
                    <p>
                        {departments.find((d) => d.id === file.departmentId)?.name} →{" "}
                        {departments.find((d) => d.id === draft.departmentId)?.name} /{" "}
                        {draft.folderId ? (folders.find((f) => f.id === draft.folderId)?.name ?? "โฟลเดอร์ที่เลือก") : "ระดับบนสุด"}
                    </p>
                    <p>ผู้มองเห็นอาจเปลี่ยนตามสิทธิ์ปลายทาง รวมเวอร์ชันย้อนหลัง</p>
                    <div className="dialog-actions">
                        <DialogClose asChild>
                            <button className="secondary" disabled={busy}>
                                กลับไปแก้ไข
                            </button>
                        </DialogClose>
                        <button className="primary" disabled={busy} onClick={() => void save()}>
                            {busy ? "กำลังย้าย…" : "ย้ายเอกสาร"}
                        </button>
                    </div>
                </DialogShell>
            )}
            {remove && (
                <DialogShell
                    open
                    title="ย้ายไฟล์ไปถังขยะ?"
                    size="confirm"
                    dirty={false}
                    busy={busy}
                    initialFocus="cancel"
                    onOpenChange={(open) => {
                        if (!open) setRemove(false);
                    }}
                >
                    <h2>ย้ายไฟล์ไปถังขยะ?</h2>
                    <p className="full-name">{fileName(current)}</p>
                    <p>กู้คืนจากถังขยะได้ และยังใช้พื้นที่จัดเก็บ</p>
                    <div className="dialog-actions">
                        <DialogClose asChild>
                            <button className="secondary" disabled={busy}>
                                ยกเลิก
                            </button>
                        </DialogClose>
                        <button className="danger" disabled={busy} onClick={() => void trash()}>
                            {busy ? "กำลังดำเนินการ…" : "ย้ายไปถังขยะ"}
                        </button>
                    </div>
                </DialogShell>
            )}
        </section>
    );
    return (
        <DialogShell
            open
            title="รายละเอียดไฟล์"
            description={fileName(current)}
            size="reader"
            dirty={dirty}
            busy={busy || versionBusy}
            onOpenChange={(open) => {
                if (!open) onClose();
            }}
        >
            {content}
        </DialogShell>
    );
}
