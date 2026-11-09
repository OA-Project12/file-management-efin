"use client";

import { useCallback, useRef, useState } from "react";
import { useDmsSession } from "@/components/dms/use-dms-session";
import { AdminUsers } from "./admin-users";
import { AuditTrail } from "./audit-trail";
import { FolderAccess } from "./folder-access";
import { StorageQuotas } from "./storage-quotas";
import { ApiKeys } from "@/components/dms/api-keys";
import { AuthScreen } from "@/components/dms/auth-screen";
import { AppShell } from "@/components/dms/shell";
import { FilesWorkspace } from "@/components/dms/workspace";
import { FileDetails } from "@/components/dms/details";
import { UploadQueue } from "@/components/dms/upload-queue";
import { Trash } from "@/components/dms/trash";
import { CreationDialog, type Creation } from "@/components/dms/creation-dialog";
import { Notice } from "@/components/dms/common";
import { NavigationGuardProvider, useNavigationGuard } from "@/components/dms/navigation-guard";
import { emptyScope, type Department, type FileRow, type Folder, type Scope, type Tab } from "@/components/dms/model";

export default function Home() {
    return (
        <NavigationGuardProvider>
            <DmsApplication />
        </NavigationGuardProvider>
    );
}
function DmsApplication() {
    const { navigate, reset: resetNavigation } = useNavigationGuard();
    const [tab, setTab] = useState<Tab>("files");
    const [scope, setScope] = useState<Scope>(emptyScope),
        [folders, setFolders] = useState<Folder[]>([]);
    const [trashDepartment, setTrashDepartment] = useState<string | null>(null),
        [revision, setRevision] = useState(0),
        [usersRevision, setUsersRevision] = useState(0);
    const [selected, setSelected] = useState<{
            file: FileRow;
            preview: boolean;
        } | null>(null),
        [uploadScope, setUploadScope] = useState<Scope | null>(null);
    const [creation, setCreation] = useState<Creation | null>(null),
        [folderAccess, setFolderAccess] = useState(false),
        [notice, setNotice] = useState("");
    const opener = useRef<HTMLElement | null>(null);
    const [logoutBusy, setLogoutBusy] = useState(false);
    const logoutLock = useRef(false);
    const resetWorkspace = useCallback(() => {
        setSelected(null);
        setUploadScope(null);
        setCreation(null);
        setFolderAccess(false);
        setScope(emptyScope);
        setFolders([]);
        setTrashDepartment(null);
        setNotice("");
        setTab("files");
        resetNavigation();
    }, [resetNavigation]);
    const { api, phase, identity, setIdentity, authError, login, logout } = useDmsSession(resetWorkspace);

    async function submitLogout() {
        if (logoutLock.current) return;
        logoutLock.current = true;
        setLogoutBusy(true);
        try {
            await logout();
        } catch {
            setNotice("ออกจากระบบไม่สำเร็จ กรุณาตรวจเครือข่ายแล้วลองใหม่");
        } finally {
            logoutLock.current = false;
            setLogoutBusy(false);
        }
    }
    const refresh = useCallback(() => setRevision((value) => value + 1), []);
    const receiveFolders = useCallback((next: Folder[]) => setFolders(next), []);
    function focusPage() {
        requestAnimationFrame(() => document.getElementById("main-content")?.focus());
    }
    function selectScope(next: Scope) {
        navigate(() => {
            setSelected(null);
            setScope(next);
            setTab("files");
            setFolders([]);
            focusPage();
        });
    }
    function selectDepartment(id: string) {
        selectScope({ ...emptyScope, departmentId: id });
    }
    function selectFolder(folder: Folder) {
        const index = scope.path.findIndex((item) => item.id === folder.id);
        selectScope({
            departmentId: folder.departmentId,
            folderId: folder.id,
            path: index >= 0 ? scope.path.slice(0, index + 1) : [...scope.path, folder],
        });
    }
    function changeTab(next: Tab) {
        navigate(() => {
            setSelected(null);
            setTab(next);
            if (next === "trash" && trashDepartment === null) setTrashDepartment(scope.departmentId);
            focusPage();
        });
    }
    function openFile(file: FileRow, preview = false) {
        navigate(() => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setSelected({ file, preview });
        });
    }
    function closeDetails() {
        setSelected(null);
        requestAnimationFrame(() => {
            if (opener.current?.isConnected) opener.current.focus();
            else document.getElementById("main-content")?.focus();
        });
    }
    async function created(kind: Creation["kind"], message: string) {
        setNotice(message);
        refresh();
        if (kind === "invite") setUsersRevision((value) => value + 1);
        if (kind === "department") {
            try {
                const response = await api<{ items: Department[] }>("/departments");
                setIdentity((current) => (current ? { ...current, departments: response.data.items } : null));
            } catch {
                setNotice(`${message} แต่โหลดรายการล่าสุดไม่สำเร็จ กรุณาโหลดใหม่`);
            }
        }
    }
    if (phase !== "ready" || !identity)
        return (
            <AuthScreen
                checking={phase === "checking"}
                onLogin={login}
                error={notice || authError}
                onSignOut={authError.includes("บัญชีนี้") ? () => void submitLogout() : undefined}
            />
        );
    const department = identity.departments.find((d) => d.id === scope.departmentId);
    const detail = selected ? (
        <FileDetails
            key={selected.file.id}
            file={selected.file}
            preview={selected.preview}
            writeAllowed={identity.scopes.includes("files:write")}
            api={api}
            departments={identity.departments}
            folders={[...scope.path, ...folders]}
            onClose={closeDetails}
            onRefresh={refresh}
            onNotice={setNotice}
        />
    ) : undefined;
    return (
        <AppShell
            api={api}
            identity={identity}
            folderRevision={revision}
            scope={scope}
            tab={tab}
            details={detail}
            onAll={() => selectScope(emptyScope)}
            onDepartment={selectDepartment}
            onFolder={selectScope}
            onTab={changeTab}
            onLogout={() => navigate(() => void submitLogout())}
            logoutBusy={logoutBusy}
            onCreate={() => navigate(() => setCreation({ kind: "department", scope }))}
        >
            {notice && <Notice onClose={() => setNotice("")}>{notice}</Notice>}
            {tab === "files" ? (
                <FilesWorkspace
                    api={api}
                    scope={scope}
                    departments={identity.departments}
                    revision={revision}
                    canManageFolders={identity.isTenantAdmin}
                    writeAllowed={identity.scopes.includes("files:write")}
                    onDepartment={selectDepartment}
                    onAll={() => selectScope(emptyScope)}
                    onFolder={selectFolder}
                    onUpload={() => navigate(() => setUploadScope(scope))}
                    onCreateFolder={() => navigate(() => setCreation({ kind: "folder", scope }))}
                    onFolderAccess={() => navigate(() => setFolderAccess(true))}
                    onFile={openFile}
                    onFolders={receiveFolders}
                />
            ) : tab === "trash" ? (
                <Trash
                    writeAllowed={identity.scopes.includes("files:write")}
                    api={api}
                    departments={identity.departments}
                    departmentId={trashDepartment ?? scope.departmentId}
                    onDepartment={(id) => navigate(() => setTrashDepartment(id))}
                    onBack={() => changeTab("files")}
                    onRefresh={refresh}
                    onNotice={setNotice}
                />
            ) : tab === "users" && identity.isTenantAdmin ? (
                <AdminUsers
                    key={usersRevision}
                    api={api}
                    departments={identity.departments}
                    onNotice={setNotice}
                    onInvite={(id) => setCreation({ kind: "invite", scope, departmentId: id })}
                />
            ) : tab === "audit" && identity.isTenantAdmin ? (
                <AuditTrail api={api} />
            ) : tab === "storage" ? (
                <StorageQuotas api={api} />
            ) : tab === "keys" && identity.scopes.includes("keys:manage") ? (
                <ApiKeys api={api} departments={identity.departments} onNotice={setNotice} />
            ) : (
                <Notice tone="warning">คุณไม่มีสิทธิ์เปิดหน้านี้</Notice>
            )}
            {creation && (
                <CreationDialog
                    value={creation}
                    api={api}
                    departments={identity.departments}
                    onClose={() => setCreation(null)}
                    onCreated={(kind, message) => void created(kind, message)}
                />
            )}
            {uploadScope && identity.departments.find((d) => d.id === uploadScope.departmentId) && (
                <UploadQueue
                    api={api}
                    scope={uploadScope}
                    department={identity.departments.find((d) => d.id === uploadScope.departmentId)!}
                    onClose={() => setUploadScope(null)}
                    onRefresh={refresh}
                    onFile={openFile}
                    onDepartment={() => selectDepartment(uploadScope.departmentId)}
                />
            )}
            {folderAccess && scope.folderId && department && (
                <FolderAccess
                    folderId={scope.folderId}
                    departmentId={scope.departmentId}
                    api={api}
                    onClose={() => setFolderAccess(false)}
                    onSaved={() => {
                        setFolderAccess(false);
                        refresh();
                    }}
                    onNotice={setNotice}
                />
            )}
        </AppShell>
    );
}
