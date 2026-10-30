"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getBrowserAuth } from "@/lib/browser-auth";
import { useRouter } from "next/navigation";
import { AdminUsers } from "./admin-users";
import { FolderAccess } from "./folder-access";
import { AuditTrail } from "./audit-trail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Building2, ChevronDown, ClipboardList, Download, FileText, FolderClosed, FolderOpen, KeyRound, LogOut, Plus, RefreshCw, Search, ShieldCheck, Trash2, Upload, UsersRound, X } from "lucide-react";

type FileRow = {
    id: string;
    displayName?: string;
    originalName?: string;
    contentType: string;
    sizeBytes: string;
    folderId?: string | null;
    departmentId: string;
    department?: string | null;
    tags?: string[];
    createdAt?: string;
    trashedAt?: string;
};
type Folder = { id: string; name: string; departmentId: string; parentFolderId: string | null };
type Department = { id: string; code: string; name: string; role: "admin" | "editor" | "viewer" };
type KeyRow = {
    id: string;
    keyPrefix: string;
    scopes: string[];
    departmentGrants: Department[];
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
};
type Tab = "files" | "trash" | "keys" | "users" | "audit";
type UploadResult = { name: string; status: "pending" | "uploading" | "completed" | "partial" | "error"; message?: string; retryable?: boolean };
type BatchIntent = { index: number; status: "ready" | "error"; fileId?: string; signedUrl?: string; error?: { message: string } };
type FileFilters = { tag: string; contentType: string; createdFrom: string; createdTo: string };
type Confirmation = { title: string; description: string; actionLabel: string; action: () => Promise<void>; destructive?: boolean };
type Creation = "department" | "folder" | "invite" | null;
const emptyFilters: FileFilters = { tag: "", contentType: "", createdFrom: "", createdTo: "" };

const bangkokDate = new Intl.DateTimeFormat("th-TH-u-ca-gregory", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    year: "numeric",
});
const bangkokDateTime = new Intl.DateTimeFormat("th-TH-u-ca-gregory", {
    timeZone: "Asia/Bangkok",
    dateStyle: "medium",
    timeStyle: "short",
});
const formatBangkokDate = (value: string) => bangkokDate.format(new Date(value));
const formatBangkokDateTime = (value: string) => bangkokDateTime.format(new Date(value));

export default function Home() {
    const router = useRouter();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [connected, setConnected] = useState(false);
    const [restoringSession, setRestoringSession] = useState(true);
    const [scopes, setScopes] = useState<string[]>([]);
    const [isTenantAdmin, setIsTenantAdmin] = useState(false);
    const [usersRevision, setUsersRevision] = useState(0);
    const [showFolderAccess, setShowFolderAccess] = useState(false);
    const [tab, setTab] = useState<Tab>("files");
    const [files, setFiles] = useState<FileRow[]>([]);
    const [fileCursor, setFileCursor] = useState<string | null>(null);
    const [fileLoading, setFileLoading] = useState(false);
    const [fileError, setFileError] = useState("");
    const [filesLoaded, setFilesLoaded] = useState(false);
    const fileRequest = useRef(0);
    const [trashFiles, setTrashFiles] = useState<FileRow[]>([]);
    const [trashCursor, setTrashCursor] = useState<string | null>(null);
    const [trashLoading, setTrashLoading] = useState(false);
    const [trashError, setTrashError] = useState("");
    const [folders, setFolders] = useState<Folder[]>([]);
    const folderRequest = useRef(0);
    const [departments, setDepartments] = useState<Department[]>([]);
    const [departmentId, setDepartmentId] = useState("");
    const [folderId, setFolderId] = useState("");
    const [folderPath, setFolderPath] = useState<Folder[]>([]);
    const [owner, setOwner] = useState("postman-test-user");
    const [tag, setTag] = useState("");
    const [contentType, setContentType] = useState("");
    const [createdFrom, setCreatedFrom] = useState("");
    const [createdTo, setCreatedTo] = useState("");
    const [appliedFilters, setAppliedFilters] = useState<FileFilters>(emptyFilters);
    const [showFilters, setShowFilters] = useState(false);
    const [selected, setSelected] = useState<FileRow | null>(null);
    const inspectorCloseRef = useRef<HTMLButtonElement>(null);
    const [editingMetadata, setEditingMetadata] = useState(false);
    const [preview, setPreview] = useState("");
    const [keys, setKeys] = useState<KeyRow[]>([]);
    const [keyLoading, setKeyLoading] = useState(false);
    const [keyError, setKeyError] = useState("");
    const [newKey, setNewKey] = useState("");
    const [notice, setNotice] = useState("");
    const [uploadResults, setUploadResults] = useState<UploadResult[]>([]);
    const [failedUploads, setFailedUploads] = useState<File[]>([]);
    const [uploading, setUploading] = useState(false);
    const [creation, setCreation] = useState<Creation>(null);
    const [creationName, setCreationName] = useState("");
    const [creationEmail, setCreationEmail] = useState("");
    const [creationRole, setCreationRole] = useState<"admin" | "editor" | "viewer">("viewer");
    const [creationError, setCreationError] = useState("");
    const [creationBusy, setCreationBusy] = useState(false);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [confirmationError, setConfirmationError] = useState("");
    const [confirming, setConfirming] = useState(false);
    const [showKeyForm, setShowKeyForm] = useState(false);
    const [keyBusy, setKeyBusy] = useState(false);
    const [copiedKey, setCopiedKey] = useState(false);
    const [busy, setBusy] = useState(false);

    const api = useCallback(
        async (path: string, init: RequestInit = {}) => {
            const { data: { session } } = await getBrowserAuth().auth.getSession();
            if (!session) throw new Error("กรุณาเข้าสู่ระบบอีกครั้ง");
            const response = await fetch(`/api/v1${path}`, {
                ...init,
                headers: { Authorization: `Bearer ${session.access_token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
            return body;
        },
        [],
    );

    const loadDepartments = useCallback(async () => {
        const data = await api("/departments");
        setDepartments(data.data.items);
        return data.data.items as Department[];
    }, [api]);

    const loadFolders = useCallback(
        async (parentId = folderId, selectedDepartmentId = departmentId) => {
            const requestId = ++folderRequest.current;
            if (!selectedDepartmentId) {
                setFolders([]);
                return;
            }
            const query = new URLSearchParams({ departmentId: selectedDepartmentId });
            if (parentId) query.set("parentFolderId", parentId);
            const data = await api(`/folders?${query}`);
            if (requestId === folderRequest.current) setFolders(data.data.items);
        },
        [api, folderId, departmentId],
    );

    const search = useCallback(
        async (selectedFolderId = folderId, selectedDepartmentId = departmentId, cursor: string | null = null, filters: FileFilters = appliedFilters) => {
            const requestId = ++fileRequest.current;
            setFileLoading(true);
            setFileError("");
            const payload: Record<string, unknown> = { ownerSubject: owner, limit: 25, cursor };
            if (selectedFolderId) payload.folderId = selectedFolderId;
            if (selectedDepartmentId) payload.departmentId = selectedDepartmentId;
            if (filters.tag.trim()) payload.tag = filters.tag.trim();
            if (filters.contentType.trim()) payload.contentType = filters.contentType.trim();
            if (filters.createdFrom) payload.createdFrom = filters.createdFrom;
            if (filters.createdTo) payload.createdTo = filters.createdTo;
            try {
                const data = await api("/files/search", { method: "POST", body: JSON.stringify(payload) });
                if (requestId !== fileRequest.current) return;
                setFiles((previous) => cursor ? [...previous, ...data.data.items.filter((item: FileRow) => !previous.some((row) => row.id === item.id))] : data.data.items);
                setFileCursor(data.data.nextCursor ?? null);
                setFilesLoaded(true);
            } catch (error) {
                if (requestId === fileRequest.current) setFileError(errorText(error));
                throw error;
            } finally {
                if (requestId === fileRequest.current) setFileLoading(false);
            }
        },
        [api, owner, folderId, departmentId, appliedFilters],
    );

    const loadKeys = useCallback(async () => {
        setKeyLoading(true);
        setKeyError("");
        try { setKeys((await api("/keys")).data.items); }
        catch (error) { setKeyError(errorText(error)); throw error; }
        finally { setKeyLoading(false); }
    }, [api]);

    const loadTrash = useCallback(
        async (selectedDepartmentId = departmentId, cursor?: string) => {
            setTrashLoading(true);
            setTrashError("");
            const query = new URLSearchParams({ ownerSubject: owner, limit: "25" });
            if (selectedDepartmentId) query.set("departmentId", selectedDepartmentId);
            if (cursor) query.set("cursor", cursor);
            try {
                const data = (await api(`/files/trash?${query}`)).data as { items: FileRow[]; nextCursor: string | null };
                setTrashFiles((previous) => cursor ? [...previous, ...data.items] : data.items);
                setTrashCursor(data.nextCursor);
            } catch (error) { setTrashError(errorText(error)); throw error; }
            finally { setTrashLoading(false); }
        },
        [api, owner, departmentId],
    );

    async function navigateToFolder(id: string) {
        if (!id) {
            if (departmentId) await selectDepartment(departmentId);
            else await selectAllFiles();
            return;
        }
        switchTab("files");
        setFolderId(id);
        setFiles([]);
        setFileCursor(null);
        setSelected(null);
        setPreview("");
        setEditingMetadata(false);
        setFolderPath((current) => current.some((item) => item.id === id) ? current.slice(0, current.findIndex((item) => item.id === id) + 1) : [...current, ...folders.filter((item) => item.id === id)]);
        try {
            await Promise.all([loadFolders(id), search(id)]);
        } catch (error) {
            setNotice(errorText(error));
        }
    }

    async function selectDepartment(id: string) {
        if (!id) { await selectAllFiles(); return; }
        switchTab("files");
        setDepartmentId(id);
        setFiles([]);
        setFileCursor(null);
        setFolderId("");
        setFolderPath([]);
        setSelected(null);
        setPreview("");
        setNotice("");
        try {
            await Promise.all([loadFolders("", id), search("", id)]);
        } catch (error) {
            setNotice(errorText(error));
        }
    }

    async function selectAllFiles() {
        switchTab("files");
        setDepartmentId("");
        setFolderId("");
        setFolderPath([]);
        setFiles([]);
        setFileCursor(null);
        setNotice("");
        try {
            await Promise.all([loadFolders("", ""), search("", "")]);
        } catch (error) {
            setNotice(errorText(error));
        }
    }

    function openCreation(kind: Exclude<Creation, null>) {
        setCreation(kind);
        setCreationName("");
        setCreationEmail("");
        setCreationRole("viewer");
        setCreationError("");
    }

    async function submitCreation(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!creation) return;
        const name = creationName.trim();
        const emailValue = creationEmail.trim();
        if (creation !== "invite" && !name) { setCreationError("กรุณาระบุชื่อ"); return; }
        if (creation === "invite" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue)) { setCreationError("กรุณาระบุอีเมลที่ถูกต้อง"); return; }
        setCreationBusy(true);
        setCreationError("");
        try {
            if (creation === "department") {
                await api("/departments", { method: "POST", body: JSON.stringify({ name }) });
                setNotice("สร้างคลังหน่วยงานแล้ว");
                setCreation(null);
                try {
                    const available = await loadDepartments();
                    const created = available.find((item) => item.name.toLowerCase() === name.toLowerCase());
                    if (created) await selectDepartment(created.id);
                } catch (error) { setNotice(`สร้างคลังแล้ว แต่โหลดรายการใหม่ไม่สำเร็จ: ${errorText(error)}`); }
            } else if (creation === "folder") {
                await api("/folders", { method: "POST", body: JSON.stringify({ name, departmentId, parentFolderId: folderId || null }) });
                setNotice("สร้างโฟลเดอร์แล้ว");
                setCreation(null);
                await loadFolders().catch((error) => setNotice(`สร้างโฟลเดอร์แล้ว แต่โหลดรายการใหม่ไม่สำเร็จ: ${errorText(error)}`));
            } else {
                await api("/users/invite", { method: "POST", body: JSON.stringify({ email: emailValue, departmentGrants: [{ departmentId, role: creationRole }] }) });
                setNotice(`ส่งคำเชิญไปยัง ${emailValue} แล้ว`);
                setUsersRevision((value) => value + 1);
            }
            setCreation(null);
        } catch (error) {
            setCreationError(errorText(error));
        } finally {
            setCreationBusy(false);
        }
    }

    function createDepartment() { openCreation("department"); }

    async function connect(event: React.FormEvent) {
        event.preventDefault();
        setBusy(true);
        setNotice("");
        try {
            const { error: signInError } = await getBrowserAuth().auth.signInWithPassword({ email, password });
            if (signInError) throw signInError;
            const { data: { session } } = await getBrowserAuth().auth.getSession();
            const res = await fetch("/api/v1/me", { headers: { Authorization: `Bearer ${session?.access_token ?? ""}` } });
            if (!res.ok) throw new Error("บัญชีนี้ยังไม่มีสิทธิ์ใน tenant หรือ application");
            const identity = await res.json();
            setOwner(identity.userId);
            setScopes(identity.scopes ?? []);
            setIsTenantAdmin(Boolean(identity.isTenantAdmin));
            setTab("files");
            await loadDepartments();
            setDepartmentId("");
            setFolderId("");
            setFolderPath([]);
            setFolders([]);
            setFilesLoaded(false);
            setConnected(true);
        } catch (error) {
            setNotice(errorText(error));
        } finally {
            setBusy(false);
        }
    }

    useEffect(() => {
        if (connected) return;
        if (new URLSearchParams(window.location.hash.slice(1)).get("type") === "invite") {
            router.replace(`/set-password${window.location.search}${window.location.hash}`);
            return;
        }
        let active = true;
        getBrowserAuth().auth.getSession().then(async ({ data: { session } }) => {
            if (!session || !active) return;
            const response = await fetch("/api/v1/me", { headers: { Authorization: `Bearer ${session.access_token}` } });
            if (!response.ok) {
                const body = await response.json().catch(() => null);
                throw new Error(body?.error?.message ?? `ตรวจสิทธิ์ไม่สำเร็จ (${response.status})`);
            }
            const identity = await response.json();
            const result = await api("/departments");
            if (!active) return;
            setOwner(identity.userId);
            setScopes(identity.scopes ?? []);
            setIsTenantAdmin(Boolean(identity.isTenantAdmin));
            setTab("files");
            setDepartments(result.data.items);
            setDepartmentId("");
            setFolderId("");
            setFolderPath([]);
            setFolders([]);
            setFilesLoaded(false);
            setConnected(true);
        }).catch((error) => {
            if (active) setNotice(`กู้คืนการเข้าสู่ระบบไม่สำเร็จ: ${errorText(error)}`);
        }).finally(() => {
            if (active) setRestoringSession(false);
        });
        return () => { active = false; };
    }, [connected, api, router]);

    useEffect(() => {
        if (!connected || filesLoaded) return;
        const timer = window.setTimeout(() => {
            void Promise.all([loadFolders("", departmentId), search("", departmentId)]).catch((error) => setNotice(errorText(error)));
        }, 0);
        return () => window.clearTimeout(timer);
    }, [connected, departmentId, filesLoaded, loadFolders, search]);

    useEffect(() => {
        if (selected && window.matchMedia("(max-width: 720px)").matches) inspectorCloseRef.current?.focus();
    }, [selected]);

    async function logout() {
        await getBrowserAuth().auth.signOut();
        setConnected(false);
        setDepartments([]);
        setDepartmentId("");
        setFolderId("");
        setFolderPath([]);
        setFolders([]);
        setFiles([]);
        setFilesLoaded(false);
        setFileCursor(null);
        setTrashFiles([]);
        setOwner("");
        setIsTenantAdmin(false);
        setScopes([]);
        setTab("files");
        setSelected(null);
    }

    function inviteUser() {
        if (!departmentId) { setNotice("กรุณาเลือกหน่วยงานก่อน"); return; }
        openCreation("invite");
    }

    function createFolder() { openCreation("folder"); }

    async function upload(event: React.ChangeEvent<HTMLInputElement>) {
        const items = Array.from(event.target.files ?? []);
        event.target.value = "";
        await uploadFiles(items);
    }

    async function uploadFiles(items: File[]) {
        if (!items.length) return;
        setUploading(true);
        setFailedUploads([]);
        setUploadResults(items.map((file) => ({ name: file.name, status: "pending" })));
        const results: UploadResult[] = items.map((file) => ({ name: file.name, status: "pending" }));
        const update = (index: number, status: UploadResult["status"], message?: string, retryable = false) => {
            results[index] = { name: items[index].name, status, message, retryable };
            setUploadResults([...results]);
        };
        try {
        for (let start = 0; start < items.length; start += 20) {
            const chunk = items.slice(start, start + 20);
            let intents: BatchIntent[];
            try {
                const response = await api("/files/upload-intents/batch", {
                    method: "POST",
                    body: JSON.stringify({
                        ownerSubject: owner,
                        departmentId,
                        files: chunk.map((file) => ({
                            originalName: file.name,
                            contentType: file.type || "application/octet-stream",
                            sizeBytes: file.size,
                        })),
                    }),
                });
                intents = response.data.items as BatchIntent[];
            } catch (error) {
                chunk.forEach((_, index) => update(start + index, "error", errorText(error), true));
                continue;
            }
            const ready = intents.filter((intent) => {
                if (intent.status === "error")
                    update(start + intent.index, "error", intent.error?.message ?? "สร้าง upload intent ไม่สำเร็จ", true);
                return intent.status === "ready";
            });
            for (let offset = 0; offset < ready.length; offset += 3) {
                await Promise.all(
                    ready.slice(offset, offset + 3).map(async (intent) => {
                        const index = start + intent.index;
                        const file = items[index];
                        if (!intent.fileId || !intent.signedUrl) {
                            update(index, "error", "Upload intent ไม่สมบูรณ์", true);
                            return;
                        }
                        update(index, "uploading");
                        try {
                            const put = await fetch(intent.signedUrl, {
                                method: "PUT",
                                headers: { "Content-Type": file.type || "application/octet-stream" },
                                body: file,
                            });
                            if (!put.ok) throw new Error(`Storage upload failed (${put.status})`);
                            await api(`/files/${intent.fileId}/complete`, { method: "POST" });
                            if (folderId) {
                                try { await api(`/files/${intent.fileId}/metadata`, { method: "PATCH", body: JSON.stringify({ ownerSubject: owner, folderId }) }); }
                                catch (error) { update(index, "partial", `ไฟล์อัปโหลดแล้ว แต่ย้ายเข้าโฟลเดอร์ไม่สำเร็จ: ${errorText(error)}`); return; }
                            }
                            update(index, "completed");
                        } catch (error) {
                            update(index, "error", `${errorText(error)} · ตรวจรายการไฟล์ก่อนเลือกอัปโหลดใหม่`);
                        }
                    }),
                );
            }
        }
        setFailedUploads(items.filter((_, index) => results[index].retryable));
        try { await search(); } catch (error) { setNotice(errorText(error)); }
        const succeeded = results.filter((result) => result.status === "completed" || result.status === "partial").length;
        setNotice(`อัปโหลดแล้ว ${succeeded}/${items.length} ไฟล์${results.some((result) => result.status !== "completed") ? " · ตรวจผลรายไฟล์ด้านล่าง" : ""}`);
        } finally { setUploading(false); }
    }

    async function openPreview(file: FileRow) {
        try {
            const data = await api(`/files/${file.id}/preview-url`, { method: "POST", body: JSON.stringify({ ownerSubject: owner }) });
            setSelected(file);
            setEditingMetadata(false);
            setPreview(data.data.signedUrl);
        } catch (error) {
            setNotice(errorText(error));
        }
    }

    function selectFile(file: FileRow) { setSelected(file); setPreview(""); setEditingMetadata(false); }

    async function download(file: FileRow) {
        try {
            const data = await api(`/files/${file.id}/download-url`, { method: "POST", body: JSON.stringify({ ownerSubject: owner }) });
            window.open(data.data.signedUrl, "_blank", "noopener,noreferrer");
        } catch (error) {
            setNotice(errorText(error));
        }
    }

    async function deleteFile(file: FileRow) {
        await api(`/files/${file.id}/delete`, { method: "POST", body: JSON.stringify({ ownerSubject: owner }) });
        setSelected(null);
        setNotice("ย้ายไฟล์ไปถังขยะแล้ว");
        await Promise.allSettled([search(), loadTrash()]);
    }

    async function restoreFile(file: FileRow) {
        try {
            await api(`/files/${file.id}/restore`, { method: "POST", body: JSON.stringify({ ownerSubject: owner }) });
            setNotice("กู้คืนไฟล์แล้ว");
            await Promise.allSettled([loadTrash(), search()]);
        } catch (error) {
            setNotice(errorText(error));
        }
    }

    async function purgeFile(file: FileRow) {
        await api(`/files/${file.id}/purge`, { method: "POST", body: JSON.stringify({ ownerSubject: owner }) });
        setNotice("ส่งคำขอลบถาวรแล้ว ระบบจะลบ object ผ่าน worker");
        await loadTrash().catch(() => {});
    }

    async function updateMetadata(file: FileRow, payload: Record<string, unknown>) {
        await api(`/files/${file.id}/metadata`, { method: "PATCH", body: JSON.stringify(payload) });
        setSelected(null);
        setPreview("");
        setEditingMetadata(false);
        setNotice("บันทึกข้อมูลแล้ว");
        await search().catch(() => {});
    }

    function saveMetadata(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!selected) return;
        const form = new FormData(event.currentTarget);
        const targetDepartmentId = String(form.get("departmentId") || selected.departmentId);
        const selectedFolderId = String(form.get("folderId") || "");
        const targetFolderId = targetDepartmentId === selected.departmentId ? selectedFolderId : "";
        const payload = {
            ownerSubject: owner,
            displayName: form.get("displayName"),
            departmentId: targetDepartmentId,
            tags: String(form.get("tags") || "").split(",").map((x) => x.trim()).filter(Boolean),
            folderId: targetFolderId || null,
        };
        if (targetDepartmentId !== selected.departmentId || targetFolderId !== (selected.folderId ?? "")) {
            setConfirmationError("");
            setConfirmation({
                title: "ย้ายไฟล์และเปลี่ยนการมองเห็น?",
                description: "ผู้ที่เข้าถึงไฟล์ได้อาจเปลี่ยนตามสิทธิ์ของหน่วยงานหรือโฟลเดอร์ปลายทาง",
                actionLabel: "ย้ายและบันทึก",
                action: () => updateMetadata(selected, payload),
            });
            return;
        }
        void updateMetadata(selected, payload).catch((error) => setNotice(errorText(error)));
    }

    async function createKey(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const role = String(form.get("role"));
        const departmentGrants = form.getAll("departmentId").map((id) => ({ departmentId: String(id), role }));
        setKeyBusy(true);
        try {
            const data = await api("/keys", {
                method: "POST",
                body: JSON.stringify({ expiresInDays: Number(form.get("days")), scopes: form.getAll("scope"), departmentGrants }),
            });
            setNewKey(data.data.apiKey);
            setCopiedKey(false);
            setShowKeyForm(false);
            await loadKeys();
        } catch (error) {
            setNotice(errorText(error));
        } finally {
            setKeyBusy(false);
        }
    }

    async function revoke(row: KeyRow) {
        await api(`/keys/${row.id}`, { method: "DELETE" });
        setNotice("เพิกถอน key แล้ว");
        await loadKeys().catch(() => {});
    }

    async function runConfirmation() {
        if (!confirmation) return;
        setConfirming(true);
        setConfirmationError("");
        try {
            await confirmation.action();
            setConfirmation(null);
        } catch (error) {
            setConfirmationError(errorText(error));
        } finally {
            setConfirming(false);
        }
    }

    function applyFileFilters() {
        if (createdFrom && createdTo && createdFrom > createdTo) { setFileError("วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด"); return; }
        const next = { tag, contentType, createdFrom, createdTo };
        setAppliedFilters(next);
        void search(folderId, departmentId, null, next).catch(() => {});
    }

    function clearFileFilters() {
        setTag(""); setContentType(""); setCreatedFrom(""); setCreatedTo("");
        setAppliedFilters(emptyFilters);
        void search(folderId, departmentId, null, emptyFilters).catch(() => {});
    }

    function switchTab(next: Tab) {
        setTab(next);
        setSelected(null);
        setPreview("");
        setEditingMetadata(false);
    }

    const selectedDepartment = departments.find((item) => item.id === departmentId);
    const canEditDepartment = selectedDepartment?.role === "admin" || selectedDepartment?.role === "editor";
    const canEditFile = (file: FileRow) => { const role = departments.find((item) => item.id === file.departmentId)?.role; return role === "admin" || role === "editor"; };
    const canAdminFile = (file: FileRow) => departments.find((item) => item.id === file.departmentId)?.role === "admin";
    const isGlobalFilesView = tab === "files" && !departmentId;

    async function refreshCurrentView() {
        if (tab === "files") await Promise.all([loadDepartments(), loadFolders(), search()]);
        else if (tab === "trash") await loadTrash();
        else if (tab === "keys") await loadKeys();
    }

    if (!connected && restoringSession)
        return <main className="login"><div className="login-visual"><div className="login-wordmark">EFIN</div><div><h2>เอกสารที่สำคัญ<br />อยู่ในที่ที่ใช่</h2><p>จัดเก็บ ค้นหา และทำงานร่วมกันได้อย่างมั่นใจในทุกหน่วยงาน</p></div><small>EFIN DMS</small></div><div className="login-main"><p className="login-loading" role="status">กำลังตรวจสอบการเข้าสู่ระบบ…</p></div></main>;

    if (!connected)
        return (
            <main className="login">
                <div className="login-visual"><div className="login-wordmark">EFIN</div><div><h2>เอกสารที่สำคัญ<br />อยู่ในที่ที่ใช่</h2><p>จัดเก็บ ค้นหา และทำงานร่วมกันได้อย่างมั่นใจในทุกหน่วยงาน</p></div><small>EFIN DMS · Document Management System</small></div>
                <div className="login-main"><form className="login-card" onSubmit={connect}>
                    <div className="logo">E</div>
                    <p className="overline">ยินดีต้อนรับสู่ EFIN DMS</p>
                    <h1>เข้าสู่ระบบ</h1>
                    <p>เข้าสู่ระบบด้วยบัญชีที่ Admin เชิญ</p>
                    <label>
                        อีเมล
                        <Input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            autoComplete="email"
                            required
                        />
                    </label>
                    <label>
                        รหัสผ่าน
                        <Input
                            type={showPassword ? "text" : "password"}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete="current-password"
                            required
                        />
                    </label>
                    <button className="password-toggle" type="button" aria-pressed={showPassword} onClick={() => setShowPassword((current) => !current)}>{showPassword ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}</button>
                    {notice && <div className="notice" role="alert">{notice}</div>}
                    <Button className="primary" disabled={busy}>
                        {busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
                    </Button>
                </form></div>
            </main>
        );

    return (
        <main className="layout">
            <aside className="sidebar">
                <div className="brand">
                    <div className="logo small">E</div>
                    <b>
                        EFIN <span>DMS</span>
                    </b>
                </div>
                <div className="caption">พื้นที่ทำงาน</div>
                <button className={isGlobalFilesView ? "nav active" : "nav"} aria-current={isGlobalFilesView ? "page" : undefined} onClick={() => void selectAllFiles()}>
                    <FolderClosed aria-hidden="true" /> ไฟล์ทุกหน่วยงาน
                </button>
                <button className={tab === "trash" ? "nav active" : "nav"} onClick={() => { switchTab("trash"); void loadTrash().catch(() => {}); }}><Trash2 aria-hidden="true" /> ถังขยะ</button>
                {(isTenantAdmin || scopes.includes("keys:manage")) && <div className="caption admin-caption">การจัดการ</div>}
                {isTenantAdmin && <button className={tab === "users" ? "nav active" : "nav"} onClick={() => switchTab("users")}><UsersRound aria-hidden="true" /> ผู้ใช้และสิทธิ์</button>}
                {scopes.includes("keys:manage") && (
                    <button
                        className={tab === "keys" ? "nav active" : "nav"}
                        onClick={() => {
                            switchTab("keys");
                            void loadKeys().catch((e) => setNotice(errorText(e)));
                        }}
                    >
                        <KeyRound aria-hidden="true" /> API keys
                    </button>
                )}
                {isTenantAdmin && <button className={tab === "audit" ? "nav active" : "nav"} onClick={() => switchTab("audit")}><ClipboardList aria-hidden="true" /> Audit Trail</button>}
                <div className="caption folder-caption">
                    หน่วยงาน{" "}
                    {scopes.includes("departments:manage") && (
                        <button title="สร้างหน่วยงาน" aria-label="สร้างหน่วยงาน" onClick={createDepartment}>
                            <Plus size={18} aria-hidden="true" />
                        </button>
                    )}
                </div>
                {departments.map((department) => (
                    <button
                        key={department.id}
                        className={tab === "files" && departmentId === department.id && !folderId ? "tree active" : "tree"}
                        aria-current={tab === "files" && departmentId === department.id && !folderId ? "page" : undefined}
                        onClick={() => void selectDepartment(department.id)}
                    >
                        <Building2 aria-hidden="true" /> {department.name} <small>{department.role}</small>
                    </button>
                ))}
                <div className="caption folder-caption">โฟลเดอร์ {canEditDepartment && <button onClick={createFolder} aria-label="สร้างโฟลเดอร์"><Plus size={18} aria-hidden="true" /></button>}</div>
                {!departmentId && <p className="folder-hint">เลือกหน่วยงานเพื่อดูโฟลเดอร์</p>}
                {departmentId && folderPath.map((folder, index) => <button key={`path-${folder.id}`} className={tab === "files" && folderId === folder.id ? "tree folder-path-item active" : "tree folder-path-item"} style={{ paddingLeft: `${16 + index * 12}px` }} aria-current={tab === "files" && folderId === folder.id ? "page" : undefined} onClick={() => void navigateToFolder(folder.id)}><FolderOpen aria-hidden="true" /> {folder.name}</button>)}
                {departmentId && folders.map((folder) => (
                    <button
                        key={folder.id}
                        className="tree"
                        onClick={() => void navigateToFolder(folder.id)}
                    >
                        <FolderClosed aria-hidden="true" /> {folder.name}
                    </button>
                ))}
                <div className="side-bottom">
                    <i /> {isTenantAdmin ? "Tenant Admin" : selectedDepartment?.role ?? (departments.length ? "สมาชิกหน่วยงาน" : "ยังไม่มีสิทธิ์เข้าคลัง")}{" "}
                    <button onClick={() => void logout()} aria-label="ออกจากระบบ">
                        <LogOut size={16} aria-hidden="true" /> ออก
                    </button>
                </div>
            </aside>
            <section className="content">
                <header className="topbar">
                    <span aria-label="ตำแหน่งปัจจุบัน">
                        <FolderClosed size={16} aria-hidden="true" /> {tab === "files" ? departmentId ? `${selectedDepartment?.name ?? "หน่วยงาน"} / ${folderPath.at(-1)?.name ?? "ไฟล์ทั้งหมด"}` : "ไฟล์ทุกหน่วยงาน" : tab === "trash" ? "ถังขยะ" : tab === "users" ? "จัดการผู้ใช้" : tab === "audit" ? "ประวัติการใช้งาน" : "API keys"}
                    </span>
                    {(tab === "files" || tab === "trash" || tab === "keys") && <button className="quiet" onClick={() => void refreshCurrentView().catch((error) => setNotice(errorText(error)))}>
                        <RefreshCw size={17} aria-hidden="true" /> โหลดใหม่
                    </button>}
                </header>
                <div className="mobile-location">
                    <label>{tab === "files" ? "หน่วยงาน" : "เปิดคลังหน่วยงาน"}
                        <select value={tab === "files" ? departmentId : ""} onChange={(event) => void selectDepartment(event.target.value)}>
                            <option value="">{tab === "files" ? "ไฟล์ทุกหน่วยงาน" : "เลือกหน่วยงาน"}</option>
                            {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                        </select>
                    </label>
                    {tab === "files" && departmentId && <label>โฟลเดอร์
                        <select value={folderId} onChange={(event) => void navigateToFolder(event.target.value)}>
                            <option value="">ไฟล์ทั้งหมดใน {selectedDepartment?.name ?? "หน่วยงาน"}</option>
                            {folderPath.at(-1) && <option value={folderPath.at(-1)!.id}>{folderPath.at(-1)!.name} (ปัจจุบัน)</option>}
                            {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                        </select>
                    </label>}
                </div>
                {notice && (
                    <div className="notice-bar" role="status">
                        {notice}
                        <button onClick={() => setNotice("")} aria-label="ปิดข้อความแจ้งเตือน"><X size={16} aria-hidden="true" /></button>
                    </div>
                )}
                {tab === "files" ? (
                    <>
                        <div className="heading">
                            <div>
                                <h1>
                                    {folderId
                                        ? (folderPath.at(-1)?.name ?? "โฟลเดอร์")
                                        : departmentId ? `ไฟล์ทั้งหมดใน ${selectedDepartment?.name ?? "หน่วยงาน"}` : "ไฟล์ทุกหน่วยงาน"}
                                </h1>
                                <p>{departmentId ? `คลัง ${selectedDepartment?.name ?? "หน่วยงาน"} · สิทธิ์ ${selectedDepartment?.role ?? "ไม่มี"}` : "ไฟล์จากทุกหน่วยงานที่คุณมีสิทธิ์ · เลือกหน่วยงานเพื่อดูโฟลเดอร์หรืออัปโหลด"}</p>
                            </div>
                            <div className="actions">
                                {canEditDepartment && (
                                    <label className="primary upload">
                                        <Upload size={17} aria-hidden="true" /> อัปโหลดไฟล์
                                        <input type="file" multiple onChange={(event) => void upload(event)} disabled={uploading} aria-label="เลือกไฟล์เพื่ออัปโหลด" />
                                    </label>
                                )}
                                {(canEditDepartment || (isTenantAdmin && folderId) || scopes.includes("departments:manage")) && <details className="actions-menu">
                                    <summary>เพิ่มเติม <ChevronDown size={16} aria-hidden="true" /></summary>
                                    <div>
                                        {scopes.includes("departments:manage") && <button onClick={createDepartment}><Building2 size={16} aria-hidden="true" /> สร้างหน่วยงาน</button>}
                                        {canEditDepartment && <button onClick={createFolder}><Plus size={16} aria-hidden="true" /> สร้างโฟลเดอร์</button>}
                                        {isTenantAdmin && folderId && <button onClick={() => setShowFolderAccess(true)}><ShieldCheck size={16} aria-hidden="true" /> สิทธิ์โฟลเดอร์</button>}
                                    </div>
                                </details>}
                            </div>
                        </div>
                        {folderPath.length > 0 && <nav className="folder-breadcrumb" aria-label="เส้นทางโฟลเดอร์"><button onClick={() => void selectDepartment(departmentId)}>{selectedDepartment?.name ?? "หน่วยงาน"}</button>{folderPath.map((item) => <span key={item.id}> / <button aria-current={item.id === folderId ? "page" : undefined} onClick={() => void navigateToFolder(item.id)}>{item.name}</button></span>)}</nav>}
                        <div className="filter-toolbar">
                            <p><Search size={17} aria-hidden="true" /> {departmentId ? `รายการใน ${folderPath.at(-1)?.name ?? selectedDepartment?.name ?? "หน่วยงาน"}` : "รายการจากทุกหน่วยงาน"}</p>
                            <button className="secondary" aria-expanded={showFilters} onClick={() => setShowFilters((current) => !current)}>
                                ตัวกรอง{Object.values(appliedFilters).filter(Boolean).length ? ` (${Object.values(appliedFilters).filter(Boolean).length})` : ""} <ChevronDown size={16} aria-hidden="true" />
                            </button>
                        </div>
                        {showFilters && <form className="filters advanced-filters" onSubmit={(event) => { event.preventDefault(); applyFileFilters(); }}>
                            <label>Tag<input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="เช่น สัญญา" /></label>
                            <label>ชนิดไฟล์ (MIME)<input value={contentType} onChange={(e) => setContentType(e.target.value)} placeholder="เช่น application/pdf" /></label>
                            <label>วันที่เพิ่มตั้งแต่<input type="date" value={createdFrom} onChange={(e) => setCreatedFrom(e.target.value)} /></label>
                            <label>ถึงวันที่<input type="date" value={createdTo} min={createdFrom || undefined} onChange={(e) => setCreatedTo(e.target.value)} /></label>
                            <div className="filter-actions"><button className="secondary" type="button" onClick={clearFileFilters}>ล้างตัวกรอง</button><button className="primary" type="submit">ใช้ตัวกรอง</button></div>
                        </form>}
                        {uploadResults.length > 0 && (
                            <div className="upload-results" role="status" aria-live="polite">
                                <div className="upload-summary"><strong>ผลการอัปโหลด {uploadResults.filter((item) => item.status === "completed" || item.status === "partial").length}/{uploadResults.length} ไฟล์</strong>{failedUploads.length > 0 && <button className="secondary" disabled={uploading} onClick={() => void uploadFiles(failedUploads)}>ลองไฟล์ที่ยังไม่เริ่มอัปโหลดอีกครั้ง</button>}</div>
                                {uploadResults.map((result, index) => (
                                    <div key={index}>
                                        <span>{result.name}</span>
                                        <Badge variant={result.status === "error" || result.status === "partial" ? "destructive" : "secondary"}>
                                            {result.status === "completed"
                                                ? "สำเร็จ"
                                                : result.status === "partial"
                                                  ? result.message
                                                : result.status === "uploading"
                                                  ? "กำลังอัปโหลด"
                                                  : result.status === "pending"
                                                    ? "รอดำเนินการ"
                                                    : `ไม่สำเร็จ: ${result.message}`}
                                        </Badge>
                                    </div>
                                ))}
                            </div>
                        )}
                        {departments.length === 0 && filesLoaded && !fileLoading && <div className="state-panel"><ShieldCheck size={26} aria-hidden="true" /><h2>ยังไม่มีคลังหน่วยงานที่เข้าถึงได้</h2><p>ติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์เข้าถึงคลัง</p></div>}
                        {fileError && <div className="state-panel error-state" role="alert"><h2>โหลดรายการไฟล์ไม่สำเร็จ</h2><p>{fileError}</p><button className="secondary" onClick={() => void search().catch(() => {})}>ลองใหม่</button></div>}
                        {fileLoading && files.length === 0 && <div className="state-panel" role="status">กำลังโหลดรายการไฟล์…</div>}
                        {departments.length > 0 && <div className="table-box files-table" aria-busy={fileLoading}>
                            <table>
                                <thead>
                                    <tr>
                                        <th>ชื่อ</th>
                                        <th>แผนก</th>
                                        <th>Tags</th>
                                        <th>ขนาด</th>
                                        <th>วันที่เพิ่ม</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {folders.map((f) => (
                                        <tr key={`f-${f.id}`}>
                                            <td>
                                                <button className="filename" onClick={() => void navigateToFolder(f.id)}>
                                                    <FolderClosed size={18} aria-hidden="true" /> {f.name}
                                                </button>
                                            </td>
                                            <td>—</td>
                                            <td>—</td>
                                            <td>—</td>
                                            <td>—</td>
                                            <td>
                                                <button className="text-btn" onClick={() => void navigateToFolder(f.id)}>
                                                    เปิด →
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {files.map((f) => (
                                        <tr key={f.id} className="file-row" tabIndex={0} aria-label={`เปิดรายละเอียด ${f.displayName ?? f.originalName}`} onClick={() => selectFile(f)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); selectFile(f); } }}>
                                            <td>
                                                <button
                                                    className="filename"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        selectFile(f);
                                                    }}
                                                >
                                                    <span className="type"><FileText size={18} aria-hidden="true" /></span>
                                                    <span>
                                                        <b>{f.displayName ?? f.originalName}</b>
                                                        <small>{f.originalName}</small>
                                                    </span>
                                                </button>
                                            </td>
                                            <td>{f.department || "—"}</td>
                                            <td>{f.tags?.join(", ") || "—"}</td>
                                            <td>{bytes(Number(f.sizeBytes))}</td>
                                            <td>{f.createdAt ? formatBangkokDate(f.createdAt) : "—"}</td>
                                            <td>
                                                <button
                                                    className="text-btn"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        void openPreview(f);
                                                    }}
                                                >
                                                    ดูตัวอย่าง
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {!fileLoading && !fileError && filesLoaded && !files.length && !folders.length && (
                                        <tr>
                                            <td colSpan={6} className="empty">
                                                {Object.values(appliedFilters).some(Boolean) ? "ไม่พบไฟล์ที่ตรงกับตัวกรอง ลองล้างตัวกรอง" : departmentId ? "ยังไม่มีรายการในหน่วยงานหรือโฟลเดอร์นี้" : "ยังไม่มีไฟล์ในหน่วยงานที่คุณเข้าถึงได้"}
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                        }
                        {fileCursor && <button className="secondary load-more" disabled={fileLoading} onClick={() => void search(folderId, departmentId, fileCursor).catch(() => {})}>{fileLoading ? "กำลังโหลด…" : "โหลดไฟล์เพิ่ม"}</button>}
                    </>
                ) : tab === "trash" ? (
                    <>
                        <div className="heading">
                            <div>
                                <h1>ถังขยะ</h1>
                                <p>{departmentId ? `ไฟล์ที่ลบในคลัง ${selectedDepartment?.name ?? "หน่วยงาน"}` : "ไฟล์ที่ลบจากทุกหน่วยงานที่คุณมีสิทธิ์"} สามารถกู้คืนได้ตามสิทธิ์</p>
                            </div>
                            <button className="secondary" onClick={() => void selectAllFiles()}>
                                กลับไปไฟล์
                            </button>
                        </div>
                        {trashError && <div className="state-panel error-state" role="alert"><h2>โหลดถังขยะไม่สำเร็จ</h2><p>{trashError}</p><button className="secondary" onClick={() => void loadTrash().catch(() => {})}>ลองใหม่</button></div>}
                        <div className="table-box stack-table" aria-busy={trashLoading}>
                            <table>
                                <thead>
                                    <tr>
                                        <th>ชื่อ</th>
                                        <th>ชนิดไฟล์</th>
                                        <th>วันที่ลบ</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {trashFiles.map((file) => (
                                        <tr key={file.id}>
                                            <td data-label="ชื่อ">{file.displayName ?? file.originalName}</td>
                                            <td data-label="ชนิดไฟล์">{file.contentType}</td>
                                            <td data-label="วันที่ลบ">{file.trashedAt ? formatBangkokDateTime(file.trashedAt) : "—"}</td>
                                            <td data-label="การดำเนินการ">
                                                {canEditFile(file) && (
                                                    <button className="text-btn" onClick={() => void restoreFile(file)}>
                                                        กู้คืน
                                                    </button>
                                                )}
                                                {canAdminFile(file) && (
                                                    <button className="danger-text" onClick={() => { setConfirmationError(""); setConfirmation({ title: "ลบไฟล์ถาวร?", description: `ไฟล์ ${file.displayName ?? file.originalName} จะถูกส่งให้ worker ลบ และจะกู้คืนไม่ได้`, actionLabel: "ลบถาวร", destructive: true, action: () => purgeFile(file) }); }}>
                                                        ลบถาวร
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                    {!trashLoading && !trashError && !trashFiles.length && (
                                        <tr>
                                            <td colSpan={4} className="empty">
                                                ถังขยะว่าง
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                            {trashLoading && !trashFiles.length && <div className="empty" role="status">กำลังโหลดถังขยะ…</div>}
                        </div>
                        {trashCursor && (
                            <button className="secondary load-more" disabled={trashLoading} onClick={() => void loadTrash(departmentId, trashCursor).catch(() => {})}>
                                {trashLoading ? "กำลังโหลด…" : "โหลดเพิ่ม"}
                            </button>
                        )}
                    </>
                ) : tab === "users" ? (
                    <AdminUsers key={usersRevision} api={api} departments={departments} onNotice={setNotice} onInvite={inviteUser} />
                ) : tab === "audit" ? (
                    <AuditTrail api={api} />
                ) : (
                    <>
                        <div className="heading">
                            <div>
                                <h1>API keys</h1>
                                <p>กำหนดบทบาทและคลังหน่วยงานที่แต่ละ key เข้าถึงได้</p>
                            </div>
                            <button className="primary" aria-expanded={showKeyForm} onClick={() => setShowKeyForm((current) => !current)}>
                                <Plus size={17} aria-hidden="true" /> {showKeyForm ? "ปิดฟอร์ม" : "สร้าง API key"}
                            </button>
                        </div>
                        {showKeyForm && <form id="new-key-form" className="key-form" onSubmit={createKey}>
                            <p className="form-help">กำหนดอายุ บทบาท และคลังที่ key นี้ใช้งานได้ ตรวจสิทธิ์ก่อนสร้าง เพราะ secret จะแสดงเพียงครั้งเดียว</p>
                            <label>
                                อายุ (วัน)
                                <input name="days" type="number" min="1" max="365" defaultValue="90" />
                            </label>
                            <label>
                                บทบาท
                                <select name="role" defaultValue="viewer">
                                    <option value="viewer">Viewer</option>
                                    <option value="editor">Editor</option>
                                    <option value="admin">Admin</option>
                                </select>
                            </label>
                            <fieldset>
                                <legend>คลังที่ key เข้าถึงได้</legend>
                                {departments.map((item) => (
                                    <label key={item.id}>
                                        <input type="checkbox" name="departmentId" value={item.id} /> {item.name}
                                    </label>
                                ))}
                            </fieldset>
                            <label>
                                <input type="checkbox" name="scope" value="files:read" defaultChecked /> files:read
                            </label>
                            <label>
                                <input type="checkbox" name="scope" value="files:write" /> files:write
                            </label>
                            <label>
                                <input type="checkbox" name="scope" value="keys:manage" /> keys:manage เฉพาะหน่วยงานที่เลือก
                            </label>
                            <button className="primary" disabled={keyBusy}>{keyBusy ? "กำลังสร้าง…" : "สร้าง key"}</button>
                        </form>}
                        {keyError && <div className="state-panel error-state" role="alert"><h2>โหลด API key ไม่สำเร็จ</h2><p>{keyError}</p><button className="secondary" onClick={() => void loadKeys().catch(() => {})}>ลองใหม่</button></div>}
                        <div className="table-box stack-table" aria-busy={keyLoading}>
                            <table>
                                <thead>
                                    <tr>
                                        <th>Key prefix</th>
                                        <th>Scopes</th>
                                        <th>คลัง/บทบาท</th>
                                        <th>หมดอายุ</th>
                                        <th>ใช้งานล่าสุด</th>
                                        <th>สถานะ</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {keys.map((row) => (
                                        <tr key={row.id}>
                                            <td data-label="Key prefix">
                                                <code>{row.keyPrefix}</code>
                                            </td>
                                            <td data-label="Scopes">{row.scopes.join(", ")}</td>
                                            <td data-label="คลัง/บทบาท">
                                                {row.departmentGrants.map((grant) => `${grant.name} (${grant.role})`).join(", ") ||
                                                    "ไม่มีสิทธิ์เข้าคลัง"}
                                            </td>
                                            <td data-label="หมดอายุ">{row.expiresAt ? formatBangkokDate(row.expiresAt) : "ไม่หมดอายุ"}</td>
                                            <td data-label="ใช้งานล่าสุด">{row.lastUsedAt ? formatBangkokDateTime(row.lastUsedAt) : "—"}</td>
                                            <td data-label="สถานะ">{row.revokedAt ? "เพิกถอนแล้ว" : "ใช้งานได้"}</td>
                                            <td data-label="การดำเนินการ">
                                                {!row.revokedAt && (
                                                    <button className="danger-text" onClick={() => { setConfirmationError(""); setConfirmation({ title: "เพิกถอน API key?", description: `Key ${row.keyPrefix} จะเรียก API ไม่ได้อีกหลังยืนยัน`, actionLabel: "เพิกถอน key", destructive: true, action: () => revoke(row) }); }}>
                                                        เพิกถอน
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {keyLoading && keys.length === 0 && <div className="empty" role="status">กำลังโหลด API key…</div>}
                            {!keyLoading && !keyError && keys.length === 0 && <div className="empty">ยังไม่มี API key</div>}
                        </div>
                    </>
                )}
            </section>
            {selected && (
                <aside className="inspector" aria-label="รายละเอียดไฟล์" onKeyDown={(event) => {
                    if (!window.matchMedia("(max-width: 720px)").matches) return;
                    if (event.key === "Escape") { setSelected(null); setPreview(""); setEditingMetadata(false); return; }
                    if (event.key !== "Tab") return;
                    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled])'));
                    const first = controls[0]; const last = controls.at(-1);
                    if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
                    else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
                }}>
                    <div className="inspector-top">
                        <div>
                            <span className="overline">DOCUMENT DETAILS</span>
                            <h2>รายละเอียดไฟล์</h2>
                        </div>
                        <button
                            ref={inspectorCloseRef}
                            className="quiet"
                            onClick={() => {
                                setSelected(null);
                                setPreview("");
                                setEditingMetadata(false);
                            }}
                        >
                            <X size={18} aria-hidden="true" /><span className="sr-only">ปิดรายละเอียดไฟล์</span>
                        </button>
                    </div>
                    <div className="preview">
                        {preview ? (
                            selected.contentType === "application/pdf" || selected.contentType === "text/plain" ? (
                                <iframe src={preview} title="File preview" />
                            ) : (
                                <img src={preview} alt={selected.displayName ?? selected.originalName ?? "Preview"} />
                            )
                        ) : (
                            <button className="secondary" onClick={() => void openPreview(selected)}>
                                ดูตัวอย่าง
                            </button>
                        )}
                    </div>
                    <div className="file-summary">
                        <span className="type">FILE</span>
                        <div>
                            <b>{selected.displayName ?? selected.originalName}</b>
                            <small>
                                {selected.contentType} · {bytes(Number(selected.sizeBytes))}
                            </small>
                        </div>
                    </div>
                    {!editingMetadata ? <div className="metadata metadata-readonly">
                        <dl><dt>ชื่อแสดงผล</dt><dd>{selected.displayName ?? selected.originalName}</dd><dt>หน่วยงาน</dt><dd>{departments.find((item) => item.id === selected.departmentId)?.name ?? selected.department ?? "—"}</dd><dt>Tags</dt><dd>{selected.tags?.join(", ") || "—"}</dd><dt>โฟลเดอร์</dt><dd>{folderPath.find((item) => item.id === selected.folderId)?.name ?? folders.find((item) => item.id === selected.folderId)?.name ?? (selected.folderId ? "โฟลเดอร์อื่น" : "เอกสารทั้งหมด")}</dd></dl>
                        {canEditFile(selected) && <button className="secondary" onClick={() => setEditingMetadata(true)}>แก้ไขข้อมูลและย้ายไฟล์</button>}
                    </div> : <form key={selected.id} className="metadata" onSubmit={saveMetadata}>
                        <label>
                            ชื่อแสดงผล
                            <input name="displayName" defaultValue={selected.displayName ?? selected.originalName} />
                        </label>
                        <label>
                            คลังหน่วยงาน
                            <select name="departmentId" defaultValue={selected.departmentId} disabled={!canEditFile(selected)}>
                                {departments.map((item) => (
                                    <option key={item.id} value={item.id}>
                                        {item.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label>
                            Tags
                            <input name="tags" defaultValue={selected.tags?.join(", ") ?? ""} />
                        </label>
                        <label>
                            โฟลเดอร์
                            <select name="folderId" defaultValue={selected.folderId ?? ""}>
                                <option value="">เอกสารทั้งหมด</option>
                                {selected.folderId && !folders.some((item) => item.id === selected.folderId) && <option value={selected.folderId}>{folderPath.find((item) => item.id === selected.folderId)?.name ?? "โฟลเดอร์ปัจจุบัน"}</option>}
                                {folders.map((f) => (
                                    <option key={f.id} value={f.id}>
                                        {f.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <p className="form-help">การย้ายไฟล์อาจเปลี่ยนผู้ที่มองเห็นตามสิทธิ์ปลายทาง</p>
                        <div className="inspector-actions"><button className="secondary" type="button" onClick={() => setEditingMetadata(false)}>ยกเลิก</button><button className="primary" type="submit">บันทึกข้อมูล</button></div>
                    </form>}
                    <div className="inspector-actions">
                        <button className="secondary" onClick={() => void download(selected)}>
                            <Download size={17} aria-hidden="true" /> ดาวน์โหลด
                        </button>
                        {canEditFile(selected) && (
                            <button className="danger" onClick={() => { const file = selected; setConfirmationError(""); setConfirmation({ title: "ย้ายไฟล์ไปถังขยะ?", description: `ไฟล์ ${file.displayName ?? file.originalName} จะถูกนำออกจากรายการปกติและสามารถกู้คืนได้`, actionLabel: "ย้ายไปถังขยะ", destructive: true, action: () => deleteFile(file) }); }}>
                                <Trash2 size={17} aria-hidden="true" /> ลบไฟล์
                            </button>
                        )}
                    </div>
                </aside>
            )}
            {newKey && (
                <DialogShell open={Boolean(newKey)} onOpenChange={(open) => { if (!open) setNewKey(""); }} title="คัดลอก API key">
                    <section>
                        <h2>คัดลอก API key</h2>
                        <p>Secret แสดงครั้งเดียว เมื่อปิดหน้าต่างนี้จะเปิดดูอีกไม่ได้ กรุณาคัดลอกและเก็บในที่ปลอดภัย</p>
                        <code>{newKey}</code>
                        <button className="secondary" onClick={() => void navigator.clipboard.writeText(newKey).then(() => setCopiedKey(true)).catch(() => setNotice("คัดลอกไม่สำเร็จ กรุณาคัดลอกด้วยตนเอง"))}>
                            {copiedKey ? "คัดลอกแล้ว" : "คัดลอก key"}
                        </button>
                        <button className="primary" onClick={() => setNewKey("")}>
                            ปิด (แสดงครั้งเดียว)
                        </button>
                    </section>
                </DialogShell>
            )}
            {creation && <DialogShell open onOpenChange={(open) => { if (!open && !creationBusy) setCreation(null); }} title={creation === "department" ? "สร้างหน่วยงาน" : creation === "folder" ? "สร้างโฟลเดอร์" : "เชิญผู้ใช้"}>
                <form className="action-dialog" onSubmit={(event) => void submitCreation(event)}>
                    <h2>{creation === "department" ? "สร้างคลังหน่วยงาน" : creation === "folder" ? "สร้างโฟลเดอร์" : "เชิญผู้ใช้"}</h2>
                    <p>{creation === "department" ? "คลังใหม่จะแยกไฟล์และสิทธิ์จากหน่วยงานอื่น" : creation === "folder" ? `สร้างใน ${folderPath.at(-1)?.name ?? selectedDepartment?.name ?? "คลังปัจจุบัน"}` : `เชิญเข้าคลัง ${selectedDepartment?.name ?? "หน่วยงานปัจจุบัน"} และกำหนดบทบาทเริ่มต้น`}</p>
                    {creation === "invite" ? <><label htmlFor="invite-email">อีเมลผู้ใช้</label><input id="invite-email" type="email" required autoComplete="email" value={creationEmail} onChange={(event) => setCreationEmail(event.target.value)} /><label htmlFor="invite-role">บทบาทในหน่วยงาน</label><select id="invite-role" value={creationRole} onChange={(event) => setCreationRole(event.target.value as "admin" | "editor" | "viewer")}><option value="viewer">Viewer · ดูและดาวน์โหลด</option><option value="editor">Editor · จัดการไฟล์</option><option value="admin">Admin · จัดการไฟล์และสิทธิ์หน่วยงาน</option></select></> : <><label htmlFor="creation-name">{creation === "folder" ? "ชื่อโฟลเดอร์" : "ชื่อหน่วยงาน"}</label><input id="creation-name" required autoFocus value={creationName} onChange={(event) => setCreationName(event.target.value)} maxLength={120} /></>}
                    {creationError && <p className="field-error" role="alert">{creationError}</p>}
                    <div className="dialog-actions"><button className="secondary" type="button" disabled={creationBusy} onClick={() => setCreation(null)}>ยกเลิก</button><button className="primary" disabled={creationBusy} type="submit">{creationBusy ? "กำลังบันทึก…" : creation === "invite" ? "ส่งคำเชิญ" : "สร้าง"}</button></div>
                </form>
            </DialogShell>}
            {confirmation && <DialogShell open onOpenChange={(open) => { if (!open && !confirming) setConfirmation(null); }} title={confirmation.title}>
                <section className="action-dialog"><h2>{confirmation.title}</h2><p>{confirmation.description}</p>{confirmationError && <p className="field-error" role="alert">{confirmationError}</p>}<div className="dialog-actions"><button className="secondary" disabled={confirming} onClick={() => setConfirmation(null)}>ยกเลิก</button><button className={confirmation.destructive ? "danger" : "primary"} disabled={confirming} onClick={() => void runConfirmation()}>{confirming ? "กำลังดำเนินการ…" : confirmation.actionLabel}</button></div></section>
            </DialogShell>}
            {showFolderAccess && folderId && <FolderAccess folderId={folderId} departmentId={departmentId} api={api} onClose={() => setShowFolderAccess(false)} onSaved={() => { setShowFolderAccess(false); void loadFolders(); void search(); }} onNotice={setNotice} />}
            <nav className="mobile-nav" aria-label="เมนูมือถือ">
                <button className={tab === "files" ? "active" : ""} aria-current={tab === "files" ? "page" : undefined} onClick={() => void selectAllFiles()}><FolderClosed aria-hidden="true" />ไฟล์รวม</button>
                <button className={tab === "trash" ? "active" : ""} onClick={() => { switchTab("trash"); void loadTrash().catch(() => {}); }}><Trash2 aria-hidden="true" />ถังขยะ</button>
                {isTenantAdmin && <button className={tab === "users" ? "active" : ""} onClick={() => switchTab("users")}><UsersRound aria-hidden="true" />ผู้ใช้</button>}
                {scopes.includes("keys:manage") && <button className={tab === "keys" ? "active" : ""} onClick={() => { switchTab("keys"); void loadKeys().catch(() => {}); }}><KeyRound aria-hidden="true" />Keys</button>}
                {isTenantAdmin && <button className={tab === "audit" ? "active" : ""} onClick={() => switchTab("audit")}><ClipboardList aria-hidden="true" />Audit</button>}
            </nav>
        </main>
    );
}

function errorText(error: unknown) {
    return error instanceof Error ? error.message : "เกิดข้อผิดพลาด";
}
function bytes(value: number) {
    return value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;
}
