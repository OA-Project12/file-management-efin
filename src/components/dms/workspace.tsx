"use client";
import { invalidateRequest } from "@/components/dms/model";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ChevronRight,
  Eye,
  FolderClosed,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DialogClose, DialogShell } from "@/components/ui/dialog-shell";
import { normalizeFileSearchQuery } from "@/domain/files/file-search-query";
import type {
  Api,
  ApiError,
  Department,
  FileRow,
  Folder,
  Scope,
} from "./model";
import {
  canWrite,
  errorText,
  fileName,
  fileSize,
  formatDate,
  isDenied,
  roleLabel,
} from "./model";
import { FullName, LoadingRows, Notice, StatePanel } from "./common";

type Filters = {
  q: string;
  tag: string;
  contentType: string;
  createdFrom: string;
  createdTo: string;
};
const empty: Filters = {
  q: "",
  tag: "",
  contentType: "",
  createdFrom: "",
  createdTo: "",
};
type Props = {
  api: Api;
  scope: Scope;
  departments: Department[];
  revision: number;
  canManageFolders: boolean;
  writeAllowed: boolean;
  onDepartment: (id: string) => void;
  onAll: () => void;
  onFolder: (folder: Folder) => void;
  onUpload: () => void;
  onCreateFolder: () => void;
  onFolderAccess: () => void;
  onFile: (file: FileRow, preview?: boolean) => void;
  onFolders: (folders: Folder[]) => void;
};
export function FilesWorkspace(props: Props) {
  const { api, scope, revision, onFolders } = props;
  const [items, setItems] = useState<FileRow[]>([]),
    [folders, setFolders] = useState<Folder[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [feedback, setFeedback] = useState("");
  const [applied, setApplied] = useState<Filters>(empty),
    [draft, setDraft] = useState<Filters>(empty),
    [queryError, setQueryError] = useState("");
  const [filterOpen, setFilterOpen] = useState(false),
    [filterError, setFilterError] = useState("");
  const [departmentPicker, setDepartmentPicker] = useState(false),
    [target, setTarget] = useState("");
  const [previousPositions, setPreviousPositions] = useState(false);
  const [folderLoading, setFolderLoading] = useState(false),
    [folderError, setFolderError] = useState(""),
    [folderRetry, setFolderRetry] = useState(0);
  const [fileDenied, setFileDenied] = useState(false),
    [folderDenied, setFolderDenied] = useState(false);
  const scopeDenied = fileDenied || folderDenied;
  const serial = useRef(0),
    input = useRef<HTMLInputElement>(null);
  const department = props.departments.find((d) => d.id === scope.departmentId);
  const writer = props.writeAllowed && canWrite(department) && !scopeDenied,
    writers = props.writeAllowed ? props.departments.filter(canWrite) : [];
  const load = useCallback(
    async function run(next: string | null = null) {
      const id = ++serial.current;
      setLoading(true);
      setError("");
      if (!next) {
        setItems([]);
        setCursor(null);
      }
      try {
        const body: Record<string, unknown> = {
          limit: 25,
          cursor: next,
          ...Object.fromEntries(
            Object.entries(applied).filter(([, value]) => Boolean(value)),
          ),
        };
        if (scope.departmentId) body.departmentId = scope.departmentId;
        if (scope.folderId) body.folderId = scope.folderId;
        if (next) body.cursor = next;
        const response = await api<{
          items: FileRow[];
          nextCursor: string | null;
        }>("/files/search", { method: "POST", body: JSON.stringify(body) });
        if (id !== serial.current) return;
        setFileDenied(false);
        setItems((previous) =>
          next
            ? [
                ...previous,
                ...response.data.items.filter(
                  (file) => !previous.some((old) => old.id === file.id),
                ),
              ]
            : response.data.items,
        );
        setCursor(response.data.nextCursor);
      } catch (cause) {
        if (id !== serial.current) return;
        if (next && (cause as ApiError).code === "invalid_cursor") {
          setFeedback("รายการเปลี่ยนแล้ว เริ่มแสดงจากรายการแรก");
          await run();
          return;
        }
        setError(errorText(cause));
        if (isDenied(cause)) {
          setFileDenied(true);
          setItems([]);
          setCursor(null);
        }
      } finally {
        if (id === serial.current) setLoading(false);
      }
    },
    [api, scope.departmentId, scope.folderId, applied],
  );
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      invalidateRequest(serial);
    };
  }, [load, revision]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (!scope.departmentId) {
      const timer = setTimeout(() => {
        setFolders([]);
        onFolders([]);
        setFolderLoading(false);
        setFolderError("");
        setFolderDenied(false);
      }, 0);
      return () => clearTimeout(timer);
    }
    const query = new URLSearchParams({ departmentId: scope.departmentId });
    if (scope.folderId) query.set("parentFolderId", scope.folderId);
    const timer = setTimeout(() => {
      setFolders([]);
      onFolders([]);
      setFolderLoading(true);
      setFolderError("");
      void api<{ items: Folder[] }>(`/folders?${query}`, {
        signal: controller.signal,
      })
        .then((response) => {
          if (active) {
            setFolders(response.data.items);
            onFolders(response.data.items);
            setFolderDenied(false);
          }
        })
        .catch((cause) => {
          if (active) {
            setFolderError(errorText(cause));
            setFolderDenied(isDenied(cause));
          }
        })
        .finally(() => {
          if (active) setFolderLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    api,
    scope.departmentId,
    scope.folderId,
    revision,
    onFolders,
    folderRetry,
  ]);
  function apply(event?: FormEvent) {
    event?.preventDefault();
    let q: string;
    try {
      q = normalizeFileSearchQuery(draft.q);
    } catch {
      setQueryError(
        "ใช้คำค้นไม่เกิน 200 หน่วยอักขระ และไม่เกิน 10 คำที่คั่นด้วยช่องว่าง",
      );
      input.current?.focus();
      return;
    }
    if (
      draft.createdFrom &&
      draft.createdTo &&
      draft.createdFrom > draft.createdTo
    ) {
      setFilterError("วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด");
      return;
    }
    if (
      draft.contentType &&
      !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(draft.contentType.trim())
    ) {
      setFilterError("กรอก MIME เช่น application/pdf หรือเว้นว่าง");
      return;
    }
    const next = {
      ...draft,
      q,
      tag: draft.tag.trim(),
      contentType: draft.contentType.trim(),
    };
    setQueryError("");
    setFilterError("");
    setDraft(next);
    setApplied(next);
    setFilterOpen(false);
    setFeedback("");
  }
  function clearAll() {
    setDraft(empty);
    setApplied({ ...empty });
    setQueryError("");
    setFilterError("");
    setFilterOpen(false);
  }
  function clearQuery() {
    const next = { ...applied, q: "" };
    setApplied(next);
    setDraft(next);
    setQueryError("");
    input.current?.focus();
  }
  function remove(key: keyof Filters) {
    if (key === "q") {
      clearQuery();
      return;
    }
    const next = { ...applied, [key]: "" };
    setApplied(next);
    setDraft((current) => ({ ...next, q: current.q }));
  }
  const title = scope.folderId
    ? (scope.path.at(-1)?.name ?? "โฟลเดอร์")
    : scope.departmentId
      ? `ไฟล์ทั้งหมดใน ${department?.name ?? "หน่วยงาน"}`
      : "ไฟล์ทุกหน่วยงาน";
  const visibleFolders = applied.q || scopeDenied ? [] : folders;
  const active = Object.entries(applied).filter(([, value]) => Boolean(value));
  const filtersDirty = (Object.keys(empty) as (keyof Filters)[])
    .filter((key) => key !== "q")
    .some((key) => draft[key] !== applied[key]);
  const filterFields = (
    <>
      <label htmlFor="filter-tag">
        Tag แบบตรงค่า
        <Input
          id="filter-tag"
          aria-label="Tag แบบตรงค่า"
          maxLength={64}
          value={draft.tag}
          onChange={(e) => setDraft({ ...draft, tag: e.target.value })}
        />
        <small>ต้องตรงทั้งค่าและตัวพิมพ์เล็ก/ใหญ่</small>
      </label>
      <label htmlFor="filter-mime">
        ชนิดไฟล์ (MIME)
        <Input
          id="filter-mime"
          aria-label="ชนิดไฟล์ (MIME)"
          placeholder="เช่น application/pdf"
          value={draft.contentType}
          onChange={(e) => setDraft({ ...draft, contentType: e.target.value })}
        />
      </label>
      <label htmlFor="filter-from">
        วันที่เพิ่มตั้งแต่
        <Input
          id="filter-from"
          aria-label="วันที่เพิ่มตั้งแต่"
          type="date"
          value={draft.createdFrom}
          onChange={(e) => setDraft({ ...draft, createdFrom: e.target.value })}
        />
      </label>
      <label htmlFor="filter-to">
        ถึงวันที่
        <Input
          id="filter-to"
          aria-label="ถึงวันที่"
          type="date"
          min={draft.createdFrom || undefined}
          value={draft.createdTo}
          onChange={(e) => setDraft({ ...draft, createdTo: e.target.value })}
        />
        <small>รวมวันสิ้นสุด · เวลาไทย (UTC+7)</small>
      </label>
    </>
  );
  return (
    <section className="files-surface">
      <div className="heading">
        <div>
          <h1>{title}</h1>
          <p>
            {scope.folderId
              ? "เฉพาะไฟล์ในโฟลเดอร์นี้ ไม่รวมไฟล์ในโฟลเดอร์ลูก"
              : scope.departmentId
                ? `รวมเอกสารในโฟลเดอร์ของหน่วยงาน · ${department ? roleLabel(department.role) : ""}`
                : "เฉพาะเอกสารที่คุณเข้าถึงได้ · เลือกหน่วยงานก่อนอัปโหลดหรือสร้างโฟลเดอร์"}
          </p>
        </div>
        <div className="actions">
          {writer && (
            <button className="secondary" onClick={props.onCreateFolder}>
              <Plus aria-hidden="true" />
              สร้างโฟลเดอร์
            </button>
          )}
          {(writer || (!scope.departmentId && writers.length > 0)) && (
            <button
              className="primary"
              onClick={() =>
                scope.departmentId
                  ? props.onUpload()
                  : (setTarget(""), setDepartmentPicker(true))
              }
            >
              <Upload aria-hidden="true" />
              อัปโหลดไฟล์
            </button>
          )}
          <button
            className="icon-button"
            aria-label="รีเฟรชรายการไฟล์"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="workspace-scope">
        <label htmlFor="workspace-department">
          หน่วยงาน
          <select
            id="workspace-department"
            aria-label="หน่วยงาน"
            value={scope.departmentId}
            onChange={(e) => props.onDepartment(e.target.value)}
          >
            <option value="">ไฟล์ทุกหน่วยงาน</option>
            {props.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {roleLabel(d.role)}
              </option>
            ))}
          </select>
        </label>
        {scope.departmentId && (
          <label htmlFor="workspace-folder">
            โฟลเดอร์
            <select
              id="workspace-folder"
              aria-label="โฟลเดอร์"
              value={scope.folderId}
              onChange={(e) => {
                const folder = [...scope.path, ...folders].find(
                  (f) => f.id === e.target.value,
                );
                if (folder) props.onFolder(folder);
                else props.onDepartment(scope.departmentId);
              }}
            >
              <option value="">ไฟล์ทั้งหมดใน {department?.name}</option>
              {scope.path.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {f.id === scope.folderId ? " (ปัจจุบัน)" : ""}
                </option>
              ))}
              {folders
                .filter((f) => !scope.path.some((p) => p.id === f.id))
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>
      {scope.departmentId && (
        <nav className="folder-breadcrumb" aria-label="เส้นทางโฟลเดอร์">
          <button onClick={props.onAll}>ไฟล์ทุกหน่วยงาน</button>
          <ChevronRight aria-hidden="true" />
          {scope.folderId ? (
            <button onClick={() => props.onDepartment(scope.departmentId)}>
              {department?.name}
            </button>
          ) : (
            <span aria-current="page">{department?.name}</span>
          )}
          {scope.path.length > 3 && (
            <>
              <ChevronRight aria-hidden="true" />
              <button
                aria-expanded={previousPositions}
                onClick={() => setPreviousPositions(true)}
              >
                ตำแหน่งก่อนหน้า
              </button>
            </>
          )}
          {scope.path.slice(scope.path.length > 3 ? -2 : 0).map((f) => (
            <span key={f.id}>
              <ChevronRight aria-hidden="true" />
              {f.id === scope.folderId ? (
                <span aria-current="page">{f.name}</span>
              ) : (
                <button onClick={() => props.onFolder(f)}>{f.name}</button>
              )}
            </span>
          ))}
        </nav>
      )}
      {previousPositions && (
        <DialogShell
          open
          title="ตำแหน่งก่อนหน้า"
          size="confirm"
          dirty={false}
          onOpenChange={setPreviousPositions}
        >
          <h2>ตำแหน่งก่อนหน้า</h2>
          <nav aria-label="โฟลเดอร์ก่อนหน้า" className="previous-positions">
            {scope.path.slice(0, -2).map((folder) => (
              <button
                className="secondary"
                key={folder.id}
                onClick={() => {
                  setPreviousPositions(false);
                  props.onFolder(folder);
                }}
              >
                {folder.name}
              </button>
            ))}
          </nav>
          <DialogClose asChild>
            <button className="secondary">ปิด</button>
          </DialogClose>
        </DialogShell>
      )}
      {props.canManageFolders && scope.folderId && !scopeDenied && (
        <button
          className="secondary folder-access-trigger"
          onClick={props.onFolderAccess}
        >
          <ShieldCheck aria-hidden="true" />
          สิทธิ์โฟลเดอร์
        </button>
      )}
      <form className="file-keyword-form" onSubmit={apply} noValidate>
        <label htmlFor="file-keyword">ค้นหาชื่อไฟล์หรือ tags</label>
        <div className="search-controls">
          <Input
            id="file-keyword"
            ref={input}
            value={draft.q}
            maxLength={200}
            placeholder="ค้นหาชื่อไฟล์หรือ tags"
            aria-invalid={Boolean(queryError)}
            aria-describedby={`search-help${queryError ? " search-error" : ""}`}
            onChange={(e) => {
              setDraft({ ...draft, q: e.target.value });
              setQueryError("");
            }}
          />
          <Button type="submit">
            <Search data-icon="inline-start" aria-hidden="true" />
            ค้นหา
          </Button>
          <button
            className="secondary"
            type="button"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen(true)}
          >
            <SlidersHorizontal aria-hidden="true" />
            ตัวกรอง
            {active.filter(([key]) => key !== "q").length
              ? ` (${active.filter(([key]) => key !== "q").length})`
              : ""}
          </button>
        </div>
        <small id="search-help">
          ค้นจากชื่อและ tags ไม่ค้นเนื้อหาเอกสาร · ต้องพบทุกคำ ·
          ใช้ช่องว่างแบ่งคำ
        </small>
        {queryError && (
          <p id="search-error" className="field-error" role="alert">
            {queryError}
          </p>
        )}
      </form>
      {active.length > 0 && (
        <div className="applied-filters" aria-label="เงื่อนไขที่ใช้จริง">
          {active.map(([key, value]) => (
            <button
              key={key}
              className="filter-chip"
              onClick={() => remove(key as keyof Filters)}
              aria-label={`ล้าง${key === "q" ? "คำค้น" : key}: ${value}`}
            >
              <span>
                {key === "q"
                  ? "คำค้นที่ใช้"
                  : key === "tag"
                    ? "Tag"
                    : key === "contentType"
                      ? "MIME"
                      : key === "createdFrom"
                        ? "ตั้งแต่"
                        : "ถึง"}
                : {value}
              </span>
              <X aria-hidden="true" />
            </button>
          ))}
          {(draft.q || applied.q) && (
            <button className="quiet" onClick={clearQuery}>
              ล้างคำค้น
            </button>
          )}
          <button className="quiet" onClick={clearAll}>
            ล้างทั้งหมด
          </button>
        </div>
      )}
      {feedback && <Notice>{feedback}</Notice>}
      {scopeDenied && (
        <StatePanel
          title="ไม่พบตำแหน่งนี้ในขอบเขตที่คุณเข้าถึงได้"
          action={
            <button className="secondary" onClick={props.onAll}>
              กลับไปไฟล์ทุกหน่วยงาน
            </button>
          }
        >
          สิทธิ์ของคุณอาจเปลี่ยนแล้ว โปรดเลือกตำแหน่งใหม่
        </StatePanel>
      )}
      {!scopeDenied && folderError && (
        <Notice tone="danger">
          โหลดโฟลเดอร์ไม่สำเร็จ · {folderError}
          <button
            className="secondary"
            onClick={() => setFolderRetry((value) => value + 1)}
          >
            ลองโหลดโฟลเดอร์ใหม่
          </button>
        </Notice>
      )}
      {!applied.q && folderLoading && (
        <p role="status" className="muted">
          กำลังโหลดโฟลเดอร์…
        </p>
      )}
      {error && !scopeDenied && (
        <StatePanel
          error
          title="โหลดรายการไฟล์ไม่สำเร็จ"
          action={
            <button className="secondary" onClick={() => void load()}>
              ลองใหม่
            </button>
          }
        >
          {error}
        </StatePanel>
      )}
      {visibleFolders.length > 0 && (
        <section className="folder-list" aria-label="รายการโฟลเดอร์">
          <h2>โฟลเดอร์{scope.folderId ? "ย่อย" : "ในหน่วยงาน"}</h2>
          <div>
            {visibleFolders.map((folder) => (
              <button
                key={folder.id}
                className="folder-item"
                onClick={() => props.onFolder(folder)}
              >
                <FolderClosed aria-hidden="true" />
                <span>{folder.name}</span>
                <ChevronRight aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      )}
      {loading && !items.length ? (
        <LoadingRows />
      ) : !error && !items.length ? (
        <StatePanel
          title={
            active.length
              ? "ไม่พบเอกสารตามเงื่อนไขนี้"
              : !props.departments.length
                ? "ยังไม่มีคลังหน่วยงานที่เข้าถึงได้"
                : "ยังไม่มีเอกสารในตำแหน่งนี้"
          }
          action={
            active.length ? (
              <button className="secondary" onClick={clearAll}>
                ล้างเงื่อนไขค้นหา
              </button>
            ) : writer ? (
              <button className="secondary" onClick={props.onUpload}>
                เพิ่มเอกสารแรก
              </button>
            ) : undefined
          }
        >
          {active.length
            ? "ลองใช้คำที่สั้นลง หรือล้างเงื่อนไขเพื่อดูรายการอีกครั้ง"
            : !props.departments.length
              ? "ติดต่อผู้ดูแลองค์กรเพื่อขอสิทธิ์เข้าถึงคลัง"
              : "เอกสารที่คุณมีสิทธิ์จะปรากฏที่นี่"}
        </StatePanel>
      ) : null}
      {items.length > 0 && !scopeDenied && (
        <>
          <div className="table-box files-desktop" aria-busy={loading}>
            <table>
              <thead>
                <tr>
                  <th>ชื่อเอกสาร</th>
                  <th>หน่วยงาน</th>
                  <th className="column-tags">Tags</th>
                  <th>ขนาด</th>
                  <th className="column-date">วันที่เพิ่ม</th>
                  <th>
                    <span className="sr-only">ดูตัวอย่าง</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((file) => (
                  <tr
                    key={file.id}
                    className="file-row"
                    onClick={() => props.onFile(file)}
                  >
                    <td>
                      <button
                        className="filename"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onFile(file);
                        }}
                      >
                        <span className="file-kind">
                          {file.contentType === "application/pdf"
                            ? "PDF"
                            : "FILE"}
                        </span>
                        <span>
                          <b>{fileName(file)}</b>
                          <small>{file.originalName}</small>
                        </span>
                      </button>
                      <FullName name={fileName(file)} />
                    </td>
                    <td>
                      {props.departments.find((d) => d.id === file.departmentId)
                        ?.name ??
                        file.department ??
                        "—"}
                    </td>
                    <td className="column-tags">
                      <div className="tags">
                        {file.tags?.slice(0, 3).map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                        {(file.tags?.length ?? 0) > 3 && (
                          <span>+{file.tags!.length - 3}</span>
                        )}
                      </div>
                    </td>
                    <td className="numeric">{fileSize(file.sizeBytes)}</td>
                    <td className="column-date">
                      {formatDate(file.createdAt)}
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label={`ดูตัวอย่าง ${fileName(file)}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onFile(file, true);
                        }}
                      >
                        <Eye aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="files-mobile" aria-busy={loading}>
            {items.map((file) => (
              <article className="file-card" key={file.id}>
                <button className="filename" onClick={() => props.onFile(file)}>
                  <span className="file-kind">
                    {file.contentType === "application/pdf" ? "PDF" : "FILE"}
                  </span>
                  <b>{fileName(file)}</b>
                </button>
                <FullName name={fileName(file)} />
                <p>
                  {fileSize(file.sizeBytes)} ·{" "}
                  {props.departments.find((d) => d.id === file.departmentId)
                    ?.name ?? "หน่วยงาน"}
                </p>
                <small>{formatDate(file.createdAt)}</small>
                <button
                  className="secondary"
                  onClick={() => props.onFile(file, true)}
                >
                  <Eye aria-hidden="true" />
                  ดูตัวอย่าง
                </button>
              </article>
            ))}
          </div>
        </>
      )}
      <div className="pagination-footer">
        <p role="status" aria-live="polite">
          {loading
            ? "กำลังค้นหาไฟล์…"
            : `แสดง ${scopeDenied ? 0 : items.length} รายการที่โหลดแล้ว`}
          {cursor ? " · ยังมีรายการเพิ่มเติม" : ""}
        </p>
        {cursor && !scopeDenied && (
          <button
            className="secondary load-more"
            disabled={loading}
            onClick={() => void load(cursor)}
          >
            {loading ? "กำลังโหลด…" : "โหลดไฟล์เพิ่ม"}
          </button>
        )}
      </div>
      {filterOpen && (
        <DialogShell
          open
          title="ตัวกรองไฟล์"
          dirty={filtersDirty}
          onOpenChange={(open) => {
            if (!open) {
              setFilterOpen(false);
              setDraft((current) => ({ ...applied, q: current.q }));
              setFilterError("");
            }
          }}
        >
          <h2>ตัวกรองไฟล์</h2>
          <p>ใช้ร่วมกับคำค้นที่กำลังกรอกและตำแหน่งปัจจุบัน</p>
          <form className="filter-form" onSubmit={apply}>
            {filterFields}
            {filterError && <Notice tone="danger">{filterError}</Notice>}
            <div className="dialog-actions">
              <DialogClose asChild>
                <button type="button" className="secondary">
                  ยกเลิก
                </button>
              </DialogClose>
              <button className="secondary" type="button" onClick={clearAll}>
                ล้างทั้งหมด
              </button>
              <button className="primary" type="submit">
                ใช้ตัวกรอง
              </button>
            </div>
          </form>
        </DialogShell>
      )}
      {departmentPicker && (
        <DialogShell
          open
          title="เลือกหน่วยงานสำหรับอัปโหลด"
          dirty={false}
          onOpenChange={setDepartmentPicker}
        >
          <h2>เลือกหน่วยงานสำหรับอัปโหลด</h2>
          <p>เปิดคลังที่คุณเขียนได้ก่อนเลือกไฟล์</p>
          <label htmlFor="upload-department">
            หน่วยงาน
            <select
              id="upload-department"
              aria-label="หน่วยงานสำหรับอัปโหลด"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">เลือกหน่วยงาน</option>
              {writers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <div className="dialog-actions">
            <DialogClose asChild>
              <button className="secondary">ยกเลิก</button>
            </DialogClose>
            <button
              className="primary"
              disabled={!target}
              onClick={() => {
                setDepartmentPicker(false);
                props.onDepartment(target);
              }}
            >
              เปิดคลังหน่วยงาน
            </button>
          </div>
        </DialogShell>
      )}
    </section>
  );
}
