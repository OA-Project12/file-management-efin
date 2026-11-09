"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
    Building2,
    ChevronDown,
    ChevronRight,
    ClipboardList,
    Files,
    FolderClosed,
    HardDrive,
    KeyRound,
    LogOut,
    Menu,
    MoreHorizontal,
    Plus,
    Trash2,
    UsersRound,
} from "lucide-react";
import { DialogShell } from "@/components/ui/dialog-shell";
import type { Api, Department, Folder, Identity, Scope, Tab } from "./model";
import { errorText, roleLabel, isDenied, invalidateRequest } from "./model";

export function useMediaQuery(query: string) {
    const subscribe = useCallback(
        (callback: () => void) => {
            const media = window.matchMedia(query);
            media.addEventListener("change", callback);
            return () => media.removeEventListener("change", callback);
        },
        [query],
    );
    return useSyncExternalStore(
        subscribe,
        () => window.matchMedia(query).matches,
        () => false,
    );
}
type Props = {
    api: Api;
    identity: Identity;
    scope: Scope;
    tab: Tab;
    children: ReactNode;
    details?: ReactNode;
    folderRevision: number;
    onAll: () => void;
    onDepartment: (id: string) => void;
    onFolder: (scope: Scope) => void;
    onTab: (tab: Tab) => void;
    onLogout: () => void;
    logoutBusy: boolean;
    onCreate: () => void;
};
const titles: Record<Tab, string> = {
    files: "พื้นที่เอกสาร",
    trash: "ถังขยะ",
    users: "ผู้ใช้และสิทธิ์",
    audit: "ประวัติการใช้งาน",
    storage: "พื้นที่จัดเก็บ",
    keys: "API keys",
};
export function AppShell(props: Props) {
    const desktop = useMediaQuery("(min-width: 1024px)");
    const [drawer, setDrawer] = useState<"menu" | "more" | null>(null);
    const act = (action: () => void) => {
        setDrawer(null);
        action();
    };
    const canStorage =
        props.identity.scopes.includes("files:read") &&
        (props.identity.isTenantAdmin || props.identity.departments.some((d) => d.role !== "viewer"));
    function links(moreOnly = false) {
        return (
            <>
                {!moreOnly && (
                    <>
                        <div className="caption">พื้นที่ทำงาน</div>
                        <button
                            className={`nav ${props.tab === "files" && !props.scope.departmentId ? "active" : ""}`}
                            aria-current={props.tab === "files" && !props.scope.departmentId ? "page" : undefined}
                            onClick={() => act(props.onAll)}
                        >
                            <Files aria-hidden="true" />
                            ไฟล์ทุกหน่วยงาน
                        </button>
                        <button
                            className={`nav ${props.tab === "trash" ? "active" : ""}`}
                            aria-current={props.tab === "trash" ? "page" : undefined}
                            onClick={() => act(() => props.onTab("trash"))}
                        >
                            <Trash2 aria-hidden="true" />
                            ถังขยะ
                        </button>
                    </>
                )}
                {canStorage && (
                    <button
                        className={`nav ${props.tab === "storage" ? "active" : ""}`}
                        aria-current={props.tab === "storage" ? "page" : undefined}
                        onClick={() => act(() => props.onTab("storage"))}
                    >
                        <HardDrive aria-hidden="true" />
                        พื้นที่จัดเก็บ
                    </button>
                )}
                {(props.identity.isTenantAdmin || props.identity.scopes.includes("keys:manage")) && (
                    <div className="caption">การจัดการ</div>
                )}
                {props.identity.isTenantAdmin && (
                    <>
                        <button
                            className={`nav ${props.tab === "users" ? "active" : ""}`}
                            aria-current={props.tab === "users" ? "page" : undefined}
                            onClick={() => act(() => props.onTab("users"))}
                        >
                            <UsersRound aria-hidden="true" />
                            ผู้ใช้และสิทธิ์
                        </button>
                        <button
                            className={`nav ${props.tab === "audit" ? "active" : ""}`}
                            aria-current={props.tab === "audit" ? "page" : undefined}
                            onClick={() => act(() => props.onTab("audit"))}
                        >
                            <ClipboardList aria-hidden="true" />
                            Audit Trail
                        </button>
                    </>
                )}
                {props.identity.scopes.includes("keys:manage") && (
                    <button
                        className={`nav ${props.tab === "keys" ? "active" : ""}`}
                        aria-current={props.tab === "keys" ? "page" : undefined}
                        onClick={() => act(() => props.onTab("keys"))}
                    >
                        <KeyRound aria-hidden="true" />
                        API keys
                    </button>
                )}
                {!moreOnly && (
                    <>
                        <div className="caption caption-actions">
                            คลังหน่วยงาน
                            {props.identity.scopes.includes("departments:manage") && (
                                <button className="icon-button" aria-label="สร้างหน่วยงาน" onClick={() => act(props.onCreate)}>
                                    <Plus aria-hidden="true" />
                                </button>
                            )}
                        </div>
                        <div className="department-tree">
                            {props.identity.departments.map((department) => (
                                <DepartmentBranch key={department.id} department={department} {...props} act={act} />
                            ))}
                        </div>
                    </>
                )}
                <div className="account-menu">
                    <span>{props.identity.isTenantAdmin ? "ผู้ดูแลองค์กร" : "บัญชีสมาชิก"}</span>
                    <button className="nav" disabled={props.logoutBusy} onClick={() => act(props.onLogout)}>
                        <LogOut aria-hidden="true" />
                        {props.logoutBusy ? "กำลังออกจากระบบ…" : "ออกจากระบบ"}
                    </button>
                </div>
            </>
        );
    }
    return (
        <div className="app-shell">
            <a href="#main-content" className="skip-link">
                ข้ามไปเนื้อหาหลัก
            </a>
            {desktop && (
                <aside className="sidebar" aria-label="เมนูหลัก">
                    <div className="brand">
                        <span className="brand-mark">E</span>
                        <span>
                            EFIN <strong>DMS</strong>
                        </span>
                    </div>
                    {links()}
                </aside>
            )}
            <div className="app-column">
                <header className="app-header">
                    <button className="icon-button tablet-menu" aria-label="เปิดเมนูหลัก" onClick={() => setDrawer("menu")}>
                        <Menu aria-hidden="true" />
                    </button>
                    <span>{titles[props.tab]}</span>
                    {props.tab !== "files" && props.tab !== "trash" && (
                        <button className="quiet" onClick={() => act(() => props.onTab("files"))}>
                            กลับพื้นที่เอกสาร
                        </button>
                    )}
                    <span className="header-account">{props.identity.isTenantAdmin ? "ผู้ดูแลองค์กร" : "พื้นที่ทำงานของคุณ"}</span>
                </header>
                <div className={`app-body ${props.details ? "with-details" : ""}`}>
                    <main id="main-content" tabIndex={-1} className="page-content">
                        {props.children}
                    </main>
                    {props.details}
                </div>
            </div>
            <nav className="mobile-nav" aria-label="เมนูมือถือ">
                <button
                    className={props.tab === "files" ? "active" : ""}
                    aria-current={props.tab === "files" ? "page" : undefined}
                    onClick={() => act(() => props.onTab("files"))}
                >
                    <Files aria-hidden="true" />
                    ไฟล์
                </button>
                <button
                    className={props.tab === "trash" ? "active" : ""}
                    aria-current={props.tab === "trash" ? "page" : undefined}
                    onClick={() => act(() => props.onTab("trash"))}
                >
                    <Trash2 aria-hidden="true" />
                    ถังขยะ
                </button>
                <button
                    className={!["files", "trash"].includes(props.tab) ? "active" : ""}
                    aria-expanded={drawer === "more"}
                    onClick={() => setDrawer("more")}
                >
                    <MoreHorizontal aria-hidden="true" />
                    เพิ่มเติม
                </button>
            </nav>
            {drawer && (
                <DialogShell
                    open
                    title={drawer === "more" ? "เพิ่มเติม" : "เมนูหลัก"}
                    size={drawer === "menu" ? "drawer" : "sheet"}
                    dirty={false}
                    onOpenChange={(open) => {
                        if (!open) setDrawer(null);
                    }}
                >
                    <h2>{drawer === "more" ? "เพิ่มเติม" : "EFIN DMS"}</h2>
                    <nav aria-label={drawer === "more" ? "เมนูเพิ่มเติม" : "เมนูทั้งหมด"}>{links(drawer === "more")}</nav>
                    <button className="secondary" onClick={() => setDrawer(null)}>
                        ปิดเมนู
                    </button>
                </DialogShell>
            )}
        </div>
    );
}
function DepartmentBranch({
    department,
    scope,
    tab,
    api,
    onDepartment,
    onFolder,
    folderRevision,
    act,
}: {
    department: Department;
    scope: Scope;
    tab: Tab;
    api: Api;
    onDepartment: (id: string) => void;
    onFolder: (scope: Scope) => void;
    folderRevision: number;
    act: (action: () => void) => void;
}) {
    const [open, setOpen] = useState(false);
    const selectedPath = useMemo(
        () => (tab === "files" && scope.departmentId === department.id ? scope.path.map((folder) => folder.id) : []),
        [tab, scope.departmentId, scope.path, department.id],
    );
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
                    className={`tree ${tab === "files" && scope.departmentId === department.id && !scope.folderId ? "active" : ""}`}
                    aria-current={tab === "files" && scope.departmentId === department.id && !scope.folderId ? "page" : undefined}
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
                    selected={tab === "files" && scope.departmentId === department.id ? scope.folderId : ""}
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
