"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserAuth } from "@/lib/browser-auth";
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
import {
  CreationDialog,
  type Creation,
} from "@/components/dms/creation-dialog";
import { Notice } from "@/components/dms/common";
import {
  NavigationGuardProvider,
  useNavigationGuard,
} from "@/components/dms/navigation-guard";
import {
  emptyScope,
  type Api,
  type Department,
  type FileRow,
  type Folder,
  type Identity,
  type Scope,
  type Tab,
} from "@/components/dms/model";

export default function Home() {
  return (
    <NavigationGuardProvider>
      <DmsApplication />
    </NavigationGuardProvider>
  );
}
function DmsApplication() {
  const router = useRouter(),
    { navigate } = useNavigationGuard();
  const [phase, setPhase] = useState<"checking" | "login" | "ready">(
      "checking",
    ),
    [authError, setAuthError] = useState("");
  const [identity, setIdentity] = useState<Identity | null>(null),
    [tab, setTab] = useState<Tab>("files");
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
  const expired = useCallback(() => {
    setPhase("login");
    setIdentity(null);
    setSelected(null);
    setUploadScope(null);
    setCreation(null);
    setFolderAccess(false);
    setAuthError("การเข้าสู่ระบบหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  }, []);
  const api: Api = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const {
        data: { session },
      } = await getBrowserAuth().auth.getSession();
      if (!session) {
        expired();
        throw Object.assign(new Error("unauthorized"), {
          code: "unauthorized",
          status: 401,
        });
      }
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${session.access_token}`);
      if (init.body) headers.set("Content-Type", "application/json");
      const response = await fetch(`/api/v1${path}`, {
        ...init,
        headers,
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) expired();
        throw Object.assign(new Error("api_request_failed"), {
          code: body.error?.code,
          status: response.status,
          details: body.error?.details,
          retryAfter: Number(response.headers.get("Retry-After")) || undefined,
        });
      }
      return body;
    },
    [expired],
  );
  const loadIdentity = useCallback(async () => {
    const {
      data: { session },
    } = await getBrowserAuth().auth.getSession();
    if (!session) return false;
    const response = await fetch("/api/v1/me", {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? "membership_denied"
          : "identity_unavailable",
      );
    const current = (await response.json()) as Identity;
    const departments = await api<{ items: Department[] }>("/departments");
    setIdentity({ ...current, departments: departments.data.items });
    setScope(emptyScope);
    setFolders([]);
    setTrashDepartment(null);
    setSelected(null);
    setNotice("");
    setTab("files");
    setPhase("ready");
    setAuthError("");
    return true;
  }, [api]);
  useEffect(() => {
    if (
      new URLSearchParams(window.location.hash.slice(1)).get("type") ===
      "invite"
    ) {
      router.replace(
        `/set-password${window.location.search}${window.location.hash}`,
      );
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void loadIdentity()
        .then((found) => {
          if (active && !found) setPhase("login");
        })
        .catch((cause) => {
          if (active) {
            setPhase("login");
            setAuthError(
              cause instanceof Error && cause.message === "membership_denied"
                ? "บัญชีนี้ยังเข้าถึงพื้นที่เอกสารนี้ไม่ได้ โปรดติดต่อผู้ดูแล"
                : "ตรวจสอบการเข้าสู่ระบบไม่สำเร็จ กรุณาตรวจเครือข่ายและลองใหม่",
            );
          }
        });
    }, 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [loadIdentity, router]);
  async function login(email: string, password: string) {
    setAuthError("");
    try {
      const { error } = await getBrowserAuth().auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      await loadIdentity();
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setAuthError(
        code === "invalid_credentials"
          ? "อีเมลหรือรหัสผ่านไม่ถูกต้อง"
          : cause instanceof Error && cause.message === "membership_denied"
            ? "บัญชีนี้ยังเข้าถึงพื้นที่เอกสารนี้ไม่ได้ โปรดติดต่อผู้ดูแล"
            : "เข้าสู่ระบบไม่สำเร็จ กรุณาตรวจข้อมูลและเครือข่ายแล้วลองใหม่",
      );
    }
  }
  async function logout() {
    try {
      const { error } = await getBrowserAuth().auth.signOut();
      if (error) throw error;
      setIdentity(null);
      setSelected(null);
      setUploadScope(null);
      setCreation(null);
      setFolderAccess(false);
      setScope(emptyScope);
      setNotice("");
      setPhase("login");
      setAuthError("");
    } catch {
      setNotice("ออกจากระบบไม่สำเร็จ กรุณาตรวจเครือข่ายแล้วลองใหม่");
    }
  }
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const receiveFolders = useCallback((next: Folder[]) => setFolders(next), []);
  function focusPage() {
    requestAnimationFrame(() =>
      document.getElementById("main-content")?.focus(),
    );
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
      path:
        index >= 0 ? scope.path.slice(0, index + 1) : [...scope.path, folder],
    });
  }
  function changeTab(next: Tab) {
    navigate(() => {
      setSelected(null);
      setTab(next);
      if (next === "trash" && trashDepartment === null)
        setTrashDepartment(scope.departmentId);
      focusPage();
    });
  }
  function openFile(file: FileRow, preview = false) {
    navigate(() => {
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
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
        setIdentity((current) =>
          current ? { ...current, departments: response.data.items } : null,
        );
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
        error={authError}
        onSignOut={
          authError.includes("บัญชีนี้") ? () => void logout() : undefined
        }
      />
    );
  const department = identity.departments.find(
    (d) => d.id === scope.departmentId,
  );
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
      onLogout={() => navigate(() => void logout())}
      onCreate={() =>
        navigate(() => setCreation({ kind: "department", scope }))
      }
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
          onCreateFolder={() =>
            navigate(() => setCreation({ kind: "folder", scope }))
          }
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
          onInvite={(id) =>
            setCreation({ kind: "invite", scope, departmentId: id })
          }
        />
      ) : tab === "audit" && identity.isTenantAdmin ? (
        <AuditTrail api={api} />
      ) : tab === "storage" ? (
        <StorageQuotas api={api} />
      ) : tab === "keys" && identity.scopes.includes("keys:manage") ? (
        <ApiKeys
          api={api}
          departments={identity.departments}
          onNotice={setNotice}
        />
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
      {uploadScope &&
        identity.departments.find((d) => d.id === uploadScope.departmentId) && (
          <UploadQueue
            api={api}
            scope={uploadScope}
            department={
              identity.departments.find(
                (d) => d.id === uploadScope.departmentId,
              )!
            }
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
