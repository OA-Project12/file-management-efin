"use client";

import { useCallback, useState } from "react";

type FileRow = { id: string; displayName?: string; originalName?: string; contentType: string; sizeBytes: string; folderId?: string | null; departmentId: string; department?: string | null; tags?: string[]; createdAt?: string };
type Folder = { id: string; name: string; departmentId: string; parentFolderId: string | null };
type Department = { id: string; code: string; name: string; role: "admin" | "editor" | "viewer" };
type KeyRow = { id: string; keyPrefix: string; scopes: string[]; departmentGrants: Department[]; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null };
type Tab = "files" | "keys";

export default function Home() {
  const [key, setKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [scopes, setScopes] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("files");
  const [files, setFiles] = useState<FileRow[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentId, setDepartmentId] = useState("");
  const [folderId, setFolderId] = useState("");
  const [owner, setOwner] = useState("postman-test-user");
  const [tag, setTag] = useState("");
  const [contentType, setContentType] = useState("");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");
  const [selected, setSelected] = useState<FileRow | null>(null);
  const [preview, setPreview] = useState("");
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [newKey, setNewKey] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const api = useCallback(async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`/api/v1${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
    return body;
  }, [key]);

  const loadDepartments = useCallback(async () => {
    const data = await api("/departments");
    setDepartments(data.data.items);
    return data.data.items as Department[];
  }, [api]);

  const loadFolders = useCallback(async (parentId = folderId, selectedDepartmentId = departmentId) => {
    if (!selectedDepartmentId) { setFolders([]); return; }
    const query = new URLSearchParams({ departmentId: selectedDepartmentId });
    if (parentId) query.set("parentFolderId", parentId);
    const data = await api(`/folders?${query}`);
    setFolders(data.data.items);
  }, [api, folderId, departmentId]);

  const search = useCallback(async (selectedFolderId = folderId, selectedDepartmentId = departmentId) => {
    const payload: Record<string, unknown> = { ownerSubject: owner, limit: 100, cursor: null };
    if (selectedFolderId) payload.folderId = selectedFolderId;
    if (selectedDepartmentId) payload.departmentId = selectedDepartmentId;
    if (tag) payload.tag = tag;
    if (contentType.trim()) payload.contentType = contentType.trim();
    if (createdFrom) payload.createdFrom = createdFrom;
    if (createdTo) payload.createdTo = createdTo;
    const data = await api("/files/search", { method: "POST", body: JSON.stringify(payload) });
    setFiles(data.data.items);
  }, [api, owner, folderId, departmentId, tag, contentType, createdFrom, createdTo]);

  const loadKeys = useCallback(async () => setKeys((await api("/keys")).data.items), [api]);

  async function navigateToFolder(id: string) {
    setFolderId(id);
    try { await Promise.all([loadFolders(id), search(id)]); }
    catch (error) { setNotice(errorText(error)); }
  }

  async function selectDepartment(id: string) {
    setDepartmentId(id);
    setFolderId("");
    setSelected(null);
    setPreview("");
    try { await Promise.all([loadFolders("", id), search("", id)]); }
    catch (error) { setNotice(errorText(error)); }
  }

  async function createDepartment() {
    const name = window.prompt("ชื่อหน่วยงานใหม่");
    if (!name?.trim()) return;
    try {
      await api("/departments", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      const available = await loadDepartments();
      const created = available.find((item) => item.name.toLowerCase() === name.trim().toLowerCase());
      if (created) await selectDepartment(created.id);
      setNotice("สร้างคลังหน่วยงานแล้ว");
    } catch (error) { setNotice(errorText(error)); }
  }

  async function connect(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setNotice("");
    try {
      const res = await fetch("/api/v1/me", { headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) throw new Error("API key ใช้ไม่ได้หรือไม่มีสิทธิ์");
      const identity = await res.json();
      setScopes(identity.scopes ?? []);
      setConnected(true);
      const available = await loadDepartments();
      const initialDepartmentId = available[0]?.id ?? "";
      setDepartmentId(initialDepartmentId);
      await Promise.all([loadFolders("", initialDepartmentId), search("", initialDepartmentId)]);
    }
    catch (error) { setNotice(errorText(error)); } finally { setBusy(false); }
  }

  async function createFolder() {
    const name = window.prompt("ชื่อโฟลเดอร์"); if (!name) return;
    try { await api("/folders", { method: "POST", body: JSON.stringify({ name, departmentId, parentFolderId: folderId || null }) }); await loadFolders(); setNotice("สร้างโฟลเดอร์แล้ว"); }
    catch (error) { setNotice(errorText(error)); }
  }

  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const items = Array.from(event.target.files ?? []);
    const errors: string[] = [];
    for (const file of items) {
      setNotice(`กำลังอัปโหลด ${file.name}…`);
      try {
        const intent = await api("/files/upload-intents", { method: "POST", body: JSON.stringify({ ownerSubject: owner, departmentId, originalName: file.name, contentType: file.type || "application/octet-stream", sizeBytes: file.size }) });
        const put = await fetch(intent.data.signedUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
        if (!put.ok) throw new Error(`Storage upload failed (${put.status})`);
        await api(`/files/${intent.data.fileId}/complete`, { method: "POST" });
        if (folderId) await api(`/files/${intent.data.fileId}/metadata`, { method: "PATCH", body: JSON.stringify({ ownerSubject: owner, folderId }) });
      } catch (error) { errors.push(`${file.name}: ${errorText(error)}`); }
    }
    event.target.value = ""; await search(); setNotice(errors.length ? errors.join(" · ") : "อัปโหลดเสร็จแล้ว");
  }

  async function openPreview(file: FileRow) {
    try { const data = await api(`/files/${file.id}/preview-url`, { method: "POST", body: JSON.stringify({ ownerSubject: owner }) }); setSelected(file); setPreview(data.data.signedUrl); }
    catch (error) { setNotice(errorText(error)); }
  }

  async function download(file: FileRow) {
    try { const data = await api(`/files/${file.id}/download-url`, { method: "POST", body: JSON.stringify({ ownerSubject: owner }) }); window.open(data.data.signedUrl, "_blank", "noopener,noreferrer"); }
    catch (error) { setNotice(errorText(error)); }
  }

  async function deleteFile(file: FileRow) {
    if (!confirm(`ส่งคำขอลบ ${file.displayName ?? file.originalName}?`)) return;
    try { await api(`/files/${file.id}/delete`, { method: "POST", body: JSON.stringify({ ownerSubject: owner }) }); setSelected(null); await search(); setNotice("ส่งคำขอลบแล้ว; worker จะประมวลผลต่อ"); }
    catch (error) { setNotice(errorText(error)); }
  }

  async function saveMetadata(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return;
    const form = new FormData(event.currentTarget);
    const targetDepartmentId = String(form.get("departmentId") || selected.departmentId);
    const selectedFolderId = String(form.get("folderId") || "");
    const targetFolderId = targetDepartmentId === selected.departmentId ? selectedFolderId : "";
    try { await api(`/files/${selected.id}/metadata`, { method: "PATCH", body: JSON.stringify({ ownerSubject: owner, displayName: form.get("displayName"), departmentId: targetDepartmentId, tags: String(form.get("tags") || "").split(",").map((x) => x.trim()).filter(Boolean), folderId: targetFolderId || null }) }); setSelected(null); setPreview(""); await search(); setNotice("บันทึกข้อมูลแล้ว"); }
    catch (error) { setNotice(errorText(error)); }
  }

  async function createKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const role = String(form.get("role"));
    const departmentGrants = form.getAll("departmentId").map((id) => ({ departmentId: String(id), role }));
    try { const data = await api("/keys", { method: "POST", body: JSON.stringify({ expiresInDays: Number(form.get("days")), scopes: form.getAll("scope"), departmentGrants }) }); setNewKey(data.data.apiKey); await loadKeys(); }
    catch (error) { setNotice(errorText(error)); }
  }

  async function revoke(row: KeyRow) {
    if (!confirm(`เพิกถอน ${row.keyPrefix}?`)) return;
    try { await api(`/keys/${row.id}`, { method: "DELETE" }); await loadKeys(); setNotice("เพิกถอน key แล้ว"); }
    catch (error) { setNotice(errorText(error)); }
  }

  const selectedDepartment = departments.find((item) => item.id === departmentId);
  const canEditDepartment = selectedDepartment?.role === "admin" || selectedDepartment?.role === "editor";

  if (!connected) return <main className="login"><form className="login-card" onSubmit={connect}><div className="logo">E</div><p className="overline">EFIN · DOCUMENTS</p><h1>พื้นที่จัดการเอกสาร</h1><p>เชื่อมต่อ File Storage API เพื่อจัดการไฟล์และโฟลเดอร์</p><label>Application API key<input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="fsvc_…" autoComplete="off" required /></label><button className="primary" disabled={busy}>{busy ? "กำลังเชื่อมต่อ…" : "เชื่อมต่อ API"}</button><small>Key เก็บใน memory ของหน้านี้เท่านั้น และจะหายเมื่อ reload</small>{notice && <div className="notice">{notice}</div>}</form></main>;

  return <main className="layout">
    <aside className="sidebar"><div className="brand"><div className="logo small">E</div><b>EFIN <span>DMS</span></b></div><div className="caption">WORKSPACE</div><div className="workspace">◈　Company files　⌄</div><button className={tab === "files" ? "nav active" : "nav"} onClick={() => setTab("files")}>▤　ไฟล์และโฟลเดอร์</button>{scopes.includes("keys:manage") && <button className={tab === "keys" ? "nav active" : "nav"} onClick={() => { setTab("keys"); void loadKeys().catch((e) => setNotice(errorText(e))); }}>⌘　API keys</button>}<div className="caption folder-caption">{selectedDepartment?.name ?? "NO DEPARTMENT"} {scopes.includes("departments:manage") && <button title="สร้างหน่วยงาน" onClick={createDepartment}>＋</button>}</div>{departments.map((department) => <button key={department.id} className={departmentId === department.id ? "tree active" : "tree"} onClick={() => void selectDepartment(department.id)}>▣　{department.name} <small>{department.role}</small></button>)}<div className="caption folder-caption">FOLDERS {canEditDepartment && <button onClick={createFolder}>＋</button>}</div><button className={!folderId ? "tree active" : "tree"} onClick={() => void navigateToFolder("")}>▣　เอกสารทั้งหมด</button>{folders.map((folder) => <button key={folder.id} className={folderId === folder.id ? "tree active" : "tree"} onClick={() => void navigateToFolder(folder.id)}>▰　{folder.name}</button>)}<div className="side-bottom"><i /> {selectedDepartment?.role ?? "ไม่มีสิทธิ์"} <button onClick={() => { setConnected(false); setKey(""); }}>ออก</button></div></aside>
    <section className="content"><header className="topbar"><span>Workspace　/　{selectedDepartment?.name ?? "คลังหน่วยงาน"}　/　{tab === "files" ? folderId ? "โฟลเดอร์" : "เอกสารทั้งหมด" : "API keys"}</span><button className="quiet" onClick={() => void Promise.all([loadDepartments(), loadFolders(), search()])}>↻　Refresh</button></header>
      {notice && <div className="notice-bar">{notice}<button onClick={() => setNotice("")}>×</button></div>}
      {tab === "files" ? <><div className="heading"><div><h1>{folderId ? folders.find((x) => x.id === folderId)?.name ?? "โฟลเดอร์" : selectedDepartment?.name ?? "เอกสารทั้งหมด"}</h1><p>คลังแยกตามหน่วยงาน · สิทธิ์ {selectedDepartment?.role ?? "ไม่มี"}</p></div><div className="actions">{canEditDepartment && <button className="secondary" onClick={createFolder}>＋ โฟลเดอร์ใหม่</button>}{canEditDepartment && <label className="primary upload">↑ อัปโหลด<input type="file" multiple onChange={upload} /></label>}</div></div>
        <div className="filters"><label className="search">⌕ <input value={owner} onChange={(e) => setOwner(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void search()} placeholder="ownerSubject" /></label><input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Tag" aria-label="Tag"/><input value={contentType} onChange={(e) => setContentType(e.target.value)} placeholder="ชนิดไฟล์ เช่น application/pdf" aria-label="ชนิดไฟล์ MIME"/><label className="date-filter">ตั้งแต่ <input type="date" value={createdFrom} onChange={(e) => setCreatedFrom(e.target.value)} aria-label="วันที่เพิ่มเริ่มต้น" /></label><label className="date-filter">ถึง <input type="date" value={createdTo} min={createdFrom || undefined} onChange={(e) => setCreatedTo(e.target.value)} aria-label="วันที่เพิ่มสิ้นสุด" /></label><button className="secondary" onClick={() => void search()}>ค้นหา</button></div>
        <div className="table-box"><table><thead><tr><th>ชื่อ</th><th>แผนก</th><th>Tags</th><th>ขนาด</th><th>วันที่เพิ่ม</th><th></th></tr></thead><tbody>{folders.map((f) => <tr key={`f-${f.id}`}><td><button className="filename" onClick={() => void navigateToFolder(f.id)}>📁　{f.name}</button></td><td>—</td><td>—</td><td>—</td><td>—</td><td><button className="text-btn" onClick={() => void navigateToFolder(f.id)}>เปิด →</button></td></tr>)}{files.map((f) => <tr key={f.id} onClick={() => setSelected(f)}><td><button className="filename" onClick={(e) => { e.stopPropagation(); void openPreview(f); }}><span className="type">{f.contentType === "application/pdf" ? "PDF" : "FILE"}</span><span><b>{f.displayName ?? f.originalName}</b><small>{f.originalName}</small></span></button></td><td>{f.department || "—"}</td><td>{f.tags?.join(", ") || "—"}</td><td>{bytes(Number(f.sizeBytes))}</td><td>{f.createdAt ? new Date(f.createdAt).toLocaleDateString() : "—"}</td><td><button className="text-btn" onClick={(e) => { e.stopPropagation(); void openPreview(f); }}>ดู</button></td></tr>)}{!files.length && !folders.length && <tr><td colSpan={6} className="empty">ยังไม่มีรายการในโฟลเดอร์นี้</td></tr>}</tbody></table></div>
      </> : <><div className="heading"><div><h1>API keys</h1><p>กำหนดบทบาทและคลังหน่วยงานที่แต่ละ key เข้าถึงได้</p></div><button className="primary" onClick={() => document.getElementById("new-key-form")?.classList.toggle("hidden")}>＋ สร้าง API key</button></div><form id="new-key-form" className="key-form hidden" onSubmit={createKey}><label>อายุ (วัน)<input name="days" type="number" min="1" max="365" defaultValue="90" /></label><label>บทบาท<select name="role" defaultValue="viewer"><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option></select></label><fieldset><legend>คลังที่ key เข้าถึงได้</legend>{departments.map((item) => <label key={item.id}><input type="checkbox" name="departmentId" value={item.id} /> {item.name}</label>)}</fieldset><label><input type="checkbox" name="scope" value="files:read" defaultChecked /> files:read</label><label><input type="checkbox" name="scope" value="files:write" /> files:write</label><label><input type="checkbox" name="scope" value="keys:manage" /> keys:manage เฉพาะหน่วยงานที่เลือก</label><button className="primary">สร้าง</button></form><div className="table-box"><table><thead><tr><th>Key prefix</th><th>Scopes</th><th>คลัง/บทบาท</th><th>หมดอายุ</th><th>ใช้งานล่าสุด</th><th>สถานะ</th><th></th></tr></thead><tbody>{keys.map((row) => <tr key={row.id}><td><code>{row.keyPrefix}</code></td><td>{row.scopes.join(", ")}</td><td>{row.departmentGrants.map((grant) => `${grant.name} (${grant.role})`).join(", ") || "ไม่มีสิทธิ์เข้าคลัง"}</td><td>{row.expiresAt ? new Date(row.expiresAt).toLocaleDateString() : "ไม่หมดอายุ"}</td><td>{row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString() : "—"}</td><td>{row.revokedAt ? "เพิกถอนแล้ว" : "ใช้งานได้"}</td><td>{!row.revokedAt && <button className="danger-text" onClick={() => void revoke(row)}>เพิกถอน</button>}</td></tr>)}</tbody></table></div></>}
    </section>
    {selected && <aside className="inspector"><div className="inspector-top"><div><span className="overline">DOCUMENT DETAILS</span><h2>รายละเอียดไฟล์</h2></div><button className="quiet" onClick={() => { setSelected(null); setPreview(""); }}>×</button></div><div className="preview">{preview ? selected.contentType === "application/pdf" || selected.contentType === "text/plain" ? <iframe src={preview} title="File preview" /> : <img src={preview} alt={selected.displayName ?? selected.originalName ?? "Preview"} /> : <button className="secondary" onClick={() => void openPreview(selected)}>เปิด Preview</button>}</div><div className="file-summary"><span className="type">FILE</span><div><b>{selected.displayName ?? selected.originalName}</b><small>{selected.contentType} · {bytes(Number(selected.sizeBytes))}</small></div></div><form className="metadata" onSubmit={saveMetadata}><label>ชื่อแสดงผล<input name="displayName" defaultValue={selected.displayName ?? selected.originalName} /></label><label>คลังหน่วยงาน<select name="departmentId" defaultValue={selected.departmentId} disabled={!canEditDepartment}>{departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Tags<input name="tags" defaultValue={selected.tags?.join(", ") ?? ""} /></label><label>โฟลเดอร์<select name="folderId" defaultValue={selected.folderId ?? ""}><option value="">Root</option>{folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>{canEditDepartment && <button className="primary">บันทึก metadata</button>}</form><div className="inspector-actions"><button className="secondary" onClick={() => void download(selected)}>↓ ดาวน์โหลด</button>{canEditDepartment && <button className="danger" onClick={() => void deleteFile(selected)}>ลบไฟล์</button>}</div></aside>}
    {newKey && <div className="modal"><section><h2>คัดลอก API key</h2><p>Secret แสดงครั้งเดียว</p><code>{newKey}</code><button className="secondary" onClick={() => void navigator.clipboard.writeText(newKey)}>คัดลอก</button><button className="primary" onClick={() => setNewKey("")}>เสร็จแล้ว</button></section></div>}
  </main>;
}

function errorText(error: unknown) { return error instanceof Error ? error.message : "เกิดข้อผิดพลาด"; }
function bytes(value: number) { return value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`; }
