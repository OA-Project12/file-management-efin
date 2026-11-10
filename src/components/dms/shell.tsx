"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Building2, ChevronDown, ChevronRight, Files, FolderClosed, LogOut, Settings, Trash2, UserRound } from "lucide-react";
import { DialogClose, DialogShell } from "@/components/ui/dialog-shell";
import type { Api, Department, Folder, Identity, Scope, Tab } from "./model";
import { errorText, roleLabel, isDenied, invalidateRequest } from "./model";

export function useMediaQuery(query: string) {
    const subscribe = useCallback((callback: () => void) => {
        const media = window.matchMedia(query);
        media.addEventListener("change", callback);
        return () => media.removeEventListener("change", callback);
    }, [query]);
    return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

const managementLabels = {
    users: "ผู้ใช้และสิทธิ์",
    storage: "พื้นที่จัดเก็บ",
    audit: "ประวัติการใช้งาน",
    keys: "API Keys",
} as const;

type ManagementTab = keyof typeof managementLabels;

export function managementTabs(identity: Identity): ManagementTab[] {
    const tabs: ManagementTab[] = [];
    if (identity.isTenantAdmin) tabs.push("users");
    if (identity.scopes.includes("files:read") &&
        (identity.isTenantAdmin || identity.departments.some((department) => department.role !== "viewer"))) {
        tabs.push("storage");
    }
    if (identity.isTenantAdmin) tabs.push("audit");
    if (identity.scopes.includes("keys:manage")) tabs.push("keys");
    return tabs;
}

function AccountMenu({ identity, onLogout, logoutBusy }: {
    identity: Identity;
    onLogout: () => void;
    logoutBusy: boolean;
}) {
    const account = useRef<HTMLDetailsElement>(null);
    const trigger = useRef<HTMLElement>(null);
    return (
        <details className="editorial-account" ref={account}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
            }}
            onKeyDown={(event) => {
                if (event.key === "Escape" && event.currentTarget.open) {
                    event.currentTarget.open = false;
                    trigger.current?.focus();
                }
            }}>
            <summary aria-label="เมนูบัญชี" ref={trigger}>
                <span className="account-avatar" aria-hidden="true"><UserRound /></span>
                <span className="account-label">{identity.isTenantAdmin ? "ผู้ดูแลองค์กร" : "บัญชีสมาชิก"}</span>
                <ChevronDown aria-hidden="true" />
            </summary>
            <div className="editorial-account-actions">
                <button className="quiet" disabled={logoutBusy} onClick={() => {
                    if (account.current) account.current.open = false;
                    onLogout();
                }}>
                    <LogOut aria-hidden="true" /> {logoutBusy ? "กำลังออกจากระบบ…" : "ออกจากระบบ"}
                </button>
            </div>
        </details>
    );
}

function Brand() {
    return <span className="indigo-brand"><span className="brand-mark" aria-hidden="true"><span /></span>EFIN DMS</span>;
}

export function AppShell({ api, identity, scope, folderRevision, tab, children, details,
    onTab, onAll, onDepartment, onFolder, onLogout, logoutBusy }: {
    api: Api;
    identity: Identity;
    scope: Scope;
    folderRevision: number;
    tab: Tab;
    children: ReactNode;
    details?: ReactNode;
    onTab: (tab: Tab) => void;
    onAll: () => void;
    onDepartment: (id: string) => void;
    onFolder: (scope: Scope) => void;
    onLogout: () => void;
    logoutBusy: boolean;
}) {
    const management = managementTabs(identity);
    const managing = tab !== "files" && tab !== "trash";
    const firstManagement = management[0];
    const navigation = (
        <>
            <button aria-current={tab === "files" ? "page" : undefined} onClick={() => onTab("files")}>
                <Files aria-hidden="true" /> เอกสาร
            </button>
            <button aria-current={tab === "trash" ? "page" : undefined} onClick={() => onTab("trash")}>
                <Trash2 aria-hidden="true" /> ถังขยะ
            </button>
            {firstManagement && (
                <button aria-current={managing ? "page" : undefined} onClick={() => onTab(firstManagement)}>
                    <Settings aria-hidden="true" /> จัดการ
                </button>
            )}
        </>
    );
    return (
        <div className="app-shell">
            <a href="#main-content" className="skip-link">ข้ามไปเนื้อหาหลัก</a>
            <aside className="indigo-sidebar">
                <Brand />
                <nav className="sidebar-primary" aria-label="เมนูหลัก">{navigation}</nav>
                <div className="sidebar-scope">
                    <h2>คลังหน่วยงาน</h2>
                    <button className="tree sidebar-all" aria-current={tab === "files" && !scope.departmentId ? "page" : undefined} onClick={onAll}>
                        <FolderClosed aria-hidden="true" /><span>ทุกหน่วยงาน</span>
                    </button>
                    {identity.departments.map((department) => (
                        <DepartmentBranch key={department.id} department={department} scope={scope} api={api}
                            folderRevision={folderRevision} onDepartment={onDepartment} onFolder={onFolder}
                            active={tab === "files"} act={(action) => action()} />
                    ))}
                </div>
                <div className="sidebar-account"><AccountMenu identity={identity} onLogout={onLogout} logoutBusy={logoutBusy} /></div>
            </aside>
            <div className="indigo-workspace">
                <header className="editorial-header">
                    <span className="header-brand"><Brand /></span>
                    <div className="header-context">
                        <FolderClosed aria-hidden="true" />
                        <span>{tab === "files" ? "พื้นที่เอกสาร" : tab === "trash" ? "ถังขยะ" : "จัดการระบบ"}</span>
                        {tab === "files" && scope.departmentId && (
                            <><ChevronRight aria-hidden="true" /><strong>{identity.departments.find((item) => item.id === scope.departmentId)?.name}</strong></>
                        )}
                    </div>
                    <AccountMenu identity={identity} onLogout={onLogout} logoutBusy={logoutBusy} />
                </header>
                <main id="main-content" tabIndex={-1} className="page-content">
                    {managing && management.length > 0 && (
                        <div className="editorial-management">
                            <p className="editorial-management-title">จัดการระบบ</p>
                            <nav aria-label="เมนูจัดการระบบ">
                                {management.map((item) => (
                                    <button key={item} aria-current={item === tab ? "page" : undefined} onClick={() => onTab(item)}>
                                        {managementLabels[item]}
                                    </button>
                                ))}
                            </nav>
                        </div>
                    )}
                    {children}
                </main>
            </div>
            <nav className="editorial-primary mobile-primary" aria-label="เมนูหลักบนมือถือ">{navigation}</nav>
            {details}
        </div>
    );
}

export function FolderExplorer({ api, departments, scope, revision, onDepartment, onFolder, onClose }: {
    api: Api;
    departments: Department[];
    scope: Scope;
    revision: number;
    onDepartment: (id: string) => void;
    onFolder: (scope: Scope) => void;
    onClose: () => void;
}) {
    return (
        <DialogShell open title="เลือกโฟลเดอร์" description="เลือกหน่วยงานหรือขยายโฟลเดอร์เพื่อดูรายการย่อย" dirty={false}
            onOpenChange={(open) => { if (!open) onClose(); }}>
            <h2>เลือกโฟลเดอร์</h2>
            <div className="folder-explorer">
                {departments.map((department) => (
                    <DepartmentBranch key={department.id} department={department} scope={scope} api={api}
                        folderRevision={revision} onDepartment={onDepartment} onFolder={onFolder}
                        act={(action) => { onClose(); action(); }} />
                ))}
            </div>
            <div className="dialog-actions"><DialogClose asChild><button className="secondary">ปิด</button></DialogClose></div>
        </DialogShell>
    );
}

function DepartmentBranch({
    department,
    scope,
    api,
    onDepartment,
    onFolder,
    folderRevision,
    act,
    active = true,
}: {
    department: Department;
    scope: Scope;
    api: Api;
    onDepartment: (id: string) => void;
    onFolder: (scope: Scope) => void;
    folderRevision: number;
    act: (action: () => void) => void;
    active?: boolean;
}) {
    const [open, setOpen] = useState(scope.departmentId === department.id);
    const selectedPath = useMemo(
        () => (active && scope.departmentId === department.id ? scope.path.map((folder) => folder.id) : []),
        [active, scope.departmentId, scope.path, department.id],
    );
    useEffect(() => {
        if (!active || scope.departmentId !== department.id) return;
        const timer = setTimeout(() => setOpen(true), 0);
        return () => clearTimeout(timer);
    }, [active, scope.departmentId, department.id]);
    useEffect(() => {
        if (!selectedPath.length) return;
        const timer = setTimeout(() => setOpen(true), 0);
        return () => clearTimeout(timer);
    }, [selectedPath]);
    return (
        <div>
            <div className="tree-line">
                <button
                    className="icon-button tree-toggle"
                    aria-label={`${open ? "ยุบ" : "ขยาย"}โฟลเดอร์ ${department.name}`}
                    aria-expanded={open}
                    onClick={() => setOpen(!open)}
                >
                    {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                </button>
                <button
                    className={`tree ${active && scope.departmentId === department.id && !scope.folderId ? "active" : ""}`}
                    aria-current={active && scope.departmentId === department.id && !scope.folderId ? "page" : undefined}
                    onClick={() => act(() => onDepartment(department.id))}
                >
                    <Building2 aria-hidden="true" />
                    <span>
                        {department.name}
                        <small>{roleLabel(department.role)}</small>
                    </span>
                </button>
            </div>
            {open && (
                <FolderBranch
                    api={api}
                    revision={folderRevision}
                    departmentId={department.id}
                    parentId=""
                    ancestors={[]}
                    selectedPath={selectedPath}
                    selected={active && scope.departmentId === department.id ? scope.folderId : ""}
                    onSelect={(next) => act(() => onFolder(next))}
                />
            )}
        </div>
    );
}
function FolderBranch({
    api,
    revision,
    departmentId,
    parentId,
    ancestors,
    selectedPath,
    selected,
    onSelect,
}: {
    api: Api;
    revision: number;
    departmentId: string;
    parentId: string;
    ancestors: Folder[];
    selectedPath: string[];
    selected: string;
    onSelect: (scope: Scope) => void;
}) {
    // Each expanded branch reads only its immediate children through the existing API.
    const [folders, setFolders] = useState<Folder[] | null>(null),
        [error, setError] = useState("");
    const [open, setOpen] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const serial = useRef(0);
    const load = useCallback(async () => {
        const request = ++serial.current;
        setLoading(true);
        setError("");
        try {
            const query = new URLSearchParams({ departmentId });
            if (parentId) query.set("parentFolderId", parentId);
            const children = (await api<{ items: Folder[] }>(`/folders?${query}`)).data.items;
            if (request !== serial.current) return;
            setFolders(children);
            const reveal = children
                .filter((folder) => selectedPath.includes(folder.id) && folder.id !== selected)
                .map((folder) => folder.id);
            if (reveal.length) setOpen((current) => [...new Set([...current, ...reveal])]);
        } catch (cause) {
            if (request !== serial.current) return;
            setError(errorText(cause));
            if (isDenied(cause)) {
                setFolders([]);
                setOpen([]);
            }
        } finally {
            if (request === serial.current) setLoading(false);
        }
    }, [api, departmentId, parentId, selectedPath, selected]);
    // Lazy mount is the boundary: no full-tree scan or unauthorized folder probing.
    useEffect(() => {
        const timer = setTimeout(() => void load(), 0);
        return () => {
            clearTimeout(timer);
            invalidateRequest(serial);
        };
    }, [load, revision]);
    return (
        <div className="tree-children">
            {loading && <p role="status">กำลังโหลดโฟลเดอร์…</p>}
            {error && (
                <p role="alert">
                    {error}
                    <button className="quiet" onClick={() => void load()}>
                        ลองใหม่
                    </button>
                </p>
            )}
            {folders?.length === 0 && <p className="muted">ไม่มีโฟลเดอร์ย่อย</p>}
            {folders?.map((folder) => (
                <div key={folder.id}>
                    <div className="tree-line">
                        <button
                            className="icon-button tree-toggle"
                            aria-label={`${open.includes(folder.id) ? "ยุบ" : "ขยาย"}โฟลเดอร์ ${folder.name}`}
                            aria-expanded={open.includes(folder.id)}
                            onClick={() =>
                                setOpen((current) =>
                                    current.includes(folder.id) ? current.filter((id) => id !== folder.id) : [...current, folder.id],
                                )
                            }
                        >
                            {open.includes(folder.id) ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                        </button>
                        <button
                            className={`tree ${selected === folder.id ? "active" : ""}`}
                            aria-current={selected === folder.id ? "page" : undefined}
                            onClick={() =>
                                onSelect({
                                    departmentId,
                                    folderId: folder.id,
                                    path: [...ancestors, folder],
                                })
                            }
                        >
                            <FolderClosed aria-hidden="true" />
                            <span>{folder.name}</span>
                        </button>
                    </div>
                    {open.includes(folder.id) && (
                        <FolderBranch
                            api={api}
                            revision={revision}
                            departmentId={departmentId}
                            parentId={folder.id}
                            ancestors={[...ancestors, folder]}
                            selectedPath={selectedPath}
                            selected={selected}
                            onSelect={onSelect}
                        />
                    )}
                </div>
            ))}
        </div>
    );
}
