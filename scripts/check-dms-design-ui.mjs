// Browser plugin not available. Local production UI; all Auth, Storage and API traffic is mocked.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    "../.quota-reports/ui-runtime/node_modules/playwright",
);
const base = process.env.DESIGN_UI_URL || "http://127.0.0.1:3017";
const output = ".quota-reports/design-ui";
mkdirSync(output, { recursive: true });
const project = new URL(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
).hostname.split(".")[0];
const id = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const user = id(1),
  it = id(2),
  hr = id(3),
  folder = id(4),
  child = id(5),
  doc = id(6),
  other = id(7);
const session = {
  access_token: `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`,
  refresh_token: "fixture",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  expires_in: 3600,
  token_type: "bearer",
  user: {
    id: user,
    email: "fixture@example.invalid",
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-11-03T00:00:00Z",
  },
};
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.DESIGN_UI_BROWSER ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const reports = [];
let activePage;
async function fixture(
  role,
  width,
  authenticated = true,
  scale = 1,
  height = 960,
) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    timezoneId: "America/New_York",
  });
  if (authenticated)
    await context.addInitScript(
      ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
      { key: `sb-${project}-auth-token`, value: session },
    );
  const departments = [
    {
      id: it,
      name: "IT",
      code: "it",
      role:
        role === "tenant_admin" || role === "management"
          ? "admin"
          : role === "mixed"
            ? "editor"
            : role,
    },
    {
      id: hr,
      name: "ทรัพยากรบุคคลและการพัฒนาองค์กร",
      code: "hr",
      role:
        role === "tenant_admin" || role === "management" ? "admin" : "viewer",
    },
  ];
  const row = (fileId, name, departmentId = it, folderId = folder) => ({
    id: fileId,
    originalName: name,
    displayName: name,
    contentType: "text/plain",
    sizeBytes: "1234",
    departmentId,
    folderId,
    tags: ["นโยบาย", "2569"],
    createdAt: "2026-11-03T03:00:00Z",
  });
  let files = [
      row(
        doc,
        "คู่มือปฏิบัติงานและนโยบายการเก็บเอกสารประจำปีฉบับปรับปรุงล่าสุด.txt",
      ),
      row(other, "ข้อมูลทั่วไป.txt", hr, null),
    ],
    trash = [row(id(8), "เอกสารในถังขยะ.txt", it, null)],
    counter = 100;
  let metadataFail = false,
    searchFail = false,
    delayUploads = false;
  let used = 1000000,
    limit = "1000000000",
    revision = 1;
  const pending = new Map(),
    requests = [],
    errors = [],
    consoleErrors = [];
  const page = await context.newPage();
  activePage = page;
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await context.route("**/auth/v1/**", (route) => {
    const request = route.request();
    if (request.url().includes("/token")) {
      const body = request.postDataJSON();
      return body.password === "invalid"
        ? route.fulfill({
            status: 400,
            json: {
              error_code: "invalid_credentials",
              msg: "Invalid login credentials",
            },
          })
        : route.fulfill({ json: session });
    }
    return route.fulfill({ json: { ...session.user } });
  });
  await context.route("**/fixture-preview", (route) =>
    route.fulfill({
      contentType: "text/plain",
      body: "<script>window.fixtureExecuted=true</script>\nข้อความตัวอย่างที่ต้องแสดงเป็น text",
    }),
  );
  await context.route("**/fixture-storage/**", async (route) => {
    if (delayUploads) await new Promise((resolve) => setTimeout(resolve, 80));
    return route.fulfill({ status: 200, json: { Key: "fixture" } });
  });
  await context.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method(),
      body = request.postData() ? request.postDataJSON() : null;
    requests.push({
      path,
      method,
      body,
      query: Object.fromEntries(url.searchParams),
    });
    const ok = (data) => route.fulfill({ json: { data } }),
      fail = (code, status = 503) =>
        route.fulfill({ status, json: { error: { code } } });
    if (path.endsWith("/me"))
      return route.fulfill({
        json: {
          ...session.user,
          userId: user,
          tenantId: id(90),
          applicationId: id(91),
          isTenantAdmin: role === "tenant_admin",
          scopes: [
            "files:read",
            "files:write",
            ...(role === "management" ? ["keys:manage"] : []),
            ...(role === "tenant_admin" ? ["departments:manage"] : []),
          ],
          departments,
        },
      });
    if (path.endsWith("/departments")) {
      if (method === "POST") {
        departments.push({
          id: id(++counter),
          name: body.name,
          code: "new",
          role: "admin",
        });
        return ok({});
      }
      return ok({ items: departments });
    }
    if (path.endsWith("/storage-quotas"))
      return ok({
        items: departments
          .filter((d) => d.role !== "viewer")
          .map((d) => ({
            departmentId: d.id,
            departmentName: d.name,
            accountingStatus: "ready",
            limitBytes: limit,
            usedBytes: String(used),
            reservedBytes: "1000",
            committedBytes: String(used + 1000),
            availableBytes:
              limit === null
                ? null
                : String(BigInt(limit) - BigInt(used + 1000)),
            overQuota: false,
            revision: String(revision),
            canManageQuota: role === "tenant_admin",
          })),
      });
    if (path.endsWith("/storage-quota")) {
      limit = body.limitBytes;
      revision++;
      return ok({
        departmentId: it,
        departmentName: "IT",
        accountingStatus: "ready",
        limitBytes: limit,
        usedBytes: String(used),
        reservedBytes: "1000",
        committedBytes: String(used + 1000),
        availableBytes:
          limit === null ? null : String(BigInt(limit) - BigInt(used + 1000)),
        overQuota: false,
        revision: String(revision),
        canManageQuota: true,
      });
    }
    if (path.endsWith("/folders")) {
      if (method === "POST") return ok({});
      return ok({
        items:
          url.searchParams.get("departmentId") === it
            ? url.searchParams.get("parentFolderId") === folder
              ? [
                  {
                    id: child,
                    name: "โฟลเดอร์ลูก",
                    departmentId: it,
                    parentFolderId: folder,
                  },
                ]
              : url.searchParams.has("parentFolderId")
                ? []
                : [
                    {
                      id: folder,
                      name: "เอกสารทีม",
                      departmentId: it,
                      parentFolderId: null,
                    },
                  ]
            : [],
      });
    }
    if (path.endsWith("/access"))
      return ok({
        visibility: method === "PATCH" ? body.visibility : "department",
        userIds: method === "PATCH" ? body.userIds : [],
        folderId: folder,
        departmentId: it,
      });
    if (path.endsWith("/search")) {
      if (searchFail) {
        searchFail = false;
        return fail("service_unavailable");
      }
      const terms = (body.q || "").split(" ").filter(Boolean);
      return ok({
        items: files.filter(
          (f) =>
            (!body.departmentId || f.departmentId === body.departmentId) &&
            (!body.folderId || f.folderId === body.folderId) &&
            terms.every((term) =>
              `${f.displayName} ${f.originalName} ${f.tags.join(" ")}`.includes(
                term,
              ),
            ),
        ),
        nextCursor: null,
      });
    }
    if (path.endsWith("/upload-intents/batch"))
      return ok({
        items: body.files.map((file, index) => {
          if (file.originalName === "reject.txt")
            return {
              index,
              status: "error",
              error: { code: "department_quota_exceeded" },
            };
          const fileId = id(++counter);
          pending.set(fileId, { ...file, departmentId: body.departmentId });
          return {
            index,
            status: "ready",
            fileId,
            signedUrl: `${base}/fixture-storage/${fileId}`,
          };
        }),
      });
    const match = path.match(/\/files\/([^/]+)\/(.+)/);
    if (match) {
      const [, fileId, action] = match;
      if (action === "complete") {
        const input = pending.get(fileId);
        if (input && !files.some((f) => f.id === fileId))
          files.push({
            ...row(fileId, input.originalName, input.departmentId, null),
            contentType: input.contentType,
            sizeBytes: String(input.sizeBytes),
          });
        return ok({
          fileId,
          status: "available",
          sizeBytes: input?.sizeBytes ?? 1234,
          contentType: input?.contentType ?? "text/plain",
        });
      }
      if (action === "metadata") {
        const file = files.find((f) => f.id === fileId);
        if (file?.originalName === "partial.txt" || metadataFail) {
          metadataFail = false;
          return fail("department_quota_exceeded", 409);
        }
        if (file) {
          if (body.displayName !== undefined)
            file.displayName = body.displayName;
          if (body.departmentId) file.departmentId = body.departmentId;
          if ("folderId" in body) file.folderId = body.folderId;
          if (body.tags) file.tags = body.tags;
        }
        return ok(file || {});
      }
      if (
        action === "preview-url" ||
        action === "download-url" ||
        action.endsWith("/preview-url") ||
        action.endsWith("/download-url")
      )
        return ok({
          signedUrl: `${base}/fixture-preview`,
          fileName: "ตัวอย่าง.txt",
          contentType: "text/plain",
          expiresInSeconds: 300,
        });
      if (action === "delete") {
        const file = files.find((f) => f.id === fileId);
        if (file) {
          files = files.filter((f) => f.id !== fileId);
          trash.push({ ...file, trashedAt: "2026-11-03T04:00:00Z" });
        }
        return ok({ trashed: true });
      }
      if (action === "restore") {
        const file = trash.find((f) => f.id === fileId);
        if (file) {
          files.push(file);
          trash = trash.filter((f) => f.id !== fileId);
        }
        return ok({ restored: true });
      }
      if (action === "purge") {
        trash = trash.filter((f) => f.id !== fileId);
        return route.fulfill({ status: 202, json: { data: { queued: true } } });
      }
      if (action === "versions")
        return ok({
          currentVersionId: id(12),
          items: [
            {
              id: id(12),
              versionNumber: 2,
              originalName: "ฉบับปัจจุบัน.txt",
              contentType: "text/plain",
              sizeBytes: "1234",
              status: "available",
              createdAt: "2026-11-03T03:00:00Z",
              createdByKind: "user",
              createdById: user,
              restoredFromVersionId: null,
            },
            {
              id: id(11),
              versionNumber: 1,
              originalName: "ฉบับเก่า.txt",
              contentType: "text/plain",
              sizeBytes: "1000",
              status: "available",
              createdAt: "2026-11-02T03:00:00Z",
              createdByKind: "user",
              createdById: user,
              restoredFromVersionId: null,
            },
          ],
          nextCursor: null,
        });
    }
    if (path.endsWith("/trash"))
      return ok({
        items: trash.filter(
          (f) =>
            !url.searchParams.get("departmentId") ||
            f.departmentId === url.searchParams.get("departmentId"),
        ),
        nextCursor: null,
      });
    if (path.endsWith("/users"))
      return ok({
        items: [
          {
            userId: user,
            email: "admin.fixture@example.invalid",
            status: "active",
            isTenantAdmin: true,
            createdAt: "2026-11-03T03:00:00Z",
            departmentGrants: [],
          },
          {
            userId: id(20),
            email: "editor.fixture@example.invalid",
            status: "active",
            isTenantAdmin: false,
            createdAt: "2026-11-03T03:00:00Z",
            departmentGrants: [
              { departmentId: it, role: "editor" },
              { departmentId: hr, role: "viewer" },
            ],
          },
        ],
        nextPage: null,
      });
    if (path.endsWith("/invite") || path.includes("/users/"))
      return ok({ userId: id(22) });
    if (path.endsWith("/audit-events"))
      return ok({
        items: [
          {
            id: id(23),
            occurredAt: "2026-11-03T03:00:00Z",
            actorKind: "user",
            actorId: user,
            action: "file.download_url",
            outcome: "success",
            resourceType: "file",
            resourceId: doc,
            requestId: id(24),
            details: { sizeBytes: "1234" },
          },
        ],
        nextCursor: null,
      });
    if (path.endsWith("/keys"))
      return method === "POST"
        ? ok({ apiKey: "fsvc_fixture_only.secret-shown-once" })
        : ok({
            items: [
              {
                id: id(30),
                keyPrefix: "fsvc_fixture",
                scopes: ["files:read"],
                departmentGrants: [departments[0]],
                expiresAt: "2027-01-01T00:00:00Z",
                createdAt: "2026-11-03T03:00:00Z",
                revokedAt: null,
                lastUsedAt: null,
              },
            ],
          });
    if (path.includes("/keys/")) return fail("cannot_revoke_current_key", 409);
    return fail("fixture_unexpected", 404);
  });
  await page.goto(base);
  await page
    .getByRole("heading", {
      level: 1,
      name: authenticated ? "ไฟล์ทุกหน่วยงาน" : "เข้าสู่พื้นที่เอกสารขององค์กร",
      exact: true,
    })
    .waitFor();
  return {
    context,
    page,
    requests,
    errors,
    consoleErrors,
    setMetadataFail: () => (metadataFail = true),
    setSearchFail: () => (searchFail = true),
    delay: () => (delayUploads = true),
  };
}
async function nav(page, label, width) {
  if (width < 768) {
    if (!["ไฟล์", "ถังขยะ"].includes(label))
      await page
        .getByRole("button", { name: "เพิ่มเติม", exact: true })
        .click();
  } else if (width < 1024)
    await page
      .getByRole("button", { name: "เปิดเมนูหลัก", exact: true })
      .click();
  await page.getByRole("button", { name: label, exact: true }).click();
}
function contrast(a, b) {
  const luminance = (rgb) =>
    rgb
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number)
      .map((v) => v / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
async function renderedChecks(page, width) {
  if (width < 768) {
    const small = await page.getByRole("button").evaluateAll((elements) =>
      elements
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.width > 0 && r.height > 0 && (r.width < 43.9 || r.height < 43.9)
          );
        })
        .map((el) => ({
          name: el.textContent.trim(),
          w: el.getBoundingClientRect().width,
          h: el.getBoundingClientRect().height,
        })),
    );
    assert.deepEqual(small, [], "Mobile buttons have 44px hit areas");
  }
  const colors = await page.locator(".heading .primary").evaluate((el) => {
    const style = getComputedStyle(el);
    return { color: style.color, background: style.backgroundColor };
  });
  assert.ok(
    contrast(colors.color, colors.background) >= 4.5,
    "Rendered primary button has AA text contrast",
  );
}
async function overflow(page) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "No horizontal page overflow",
  );
  assert.equal(await page.locator("nextjs-portal").count(), 0);
}
try {
  for (const width of [375, 390, 768, 1024, 1280, 1440]) {
    const role = width === 1440 ? "tenant_admin" : "mixed";
    const f = await fixture(role, width),
      { page } = f;
    await page.getByLabel("หน่วยงาน", { exact: true }).selectOption(it);
    await page
      .getByRole("heading", { name: "ไฟล์ทั้งหมดใน IT", exact: true })
      .waitFor();
    await page
      .getByRole("combobox", { name: "โฟลเดอร์", exact: true })
      .selectOption(folder);
    if (width >= 1024) {
      await page
        .locator(".sidebar .tree.active")
        .filter({ hasText: "เอกสารทีม" })
        .waitFor();
      assert.equal(
        await page.locator(".sidebar [aria-current=page]").count(),
        1,
        "Sidebar reveals and highlights only the selected folder",
      );
    }
    await page
      .getByRole("heading", { name: "เอกสารทีม", exact: true })
      .waitFor();
    await page.locator(".filename:visible").first().click();
    await page
      .getByRole("heading", { name: "รายละเอียดไฟล์", exact: true })
      .waitFor();
    assert.equal(
      await page.locator("aside.inspector").count(),
      width >= 1312 ? 1 : 0,
      "Dock only when the content can fit",
    );
    if (width < 1312)
      assert.equal(
        await page
          .getByRole("dialog", { name: "รายละเอียดไฟล์", exact: true })
          .count(),
        1,
      );
    await page.getByRole("button", { name: "ดูตัวอย่าง", exact: true }).click();
    await page.getByText(/ข้อความตัวอย่างที่ต้องแสดงเป็น text/).waitFor();
    assert.equal(
      await page.evaluate(() => window.fixtureExecuted),
      undefined,
      "Plain text never executes HTML",
    );
    await page
      .getByRole("button", { name: "แก้ไขข้อมูลและย้ายไฟล์", exact: true })
      .click();
    await page.getByLabel("ชื่อแสดงผล", { exact: true }).fill("แก้ค้างไว้");
    await page
      .getByRole("button", { name: "ปิดรายละเอียดไฟล์", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "ละทิ้งการเปลี่ยนแปลง?", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "แก้ไขต่อ", exact: true }).click();
    assert.equal(
      await page.getByLabel("ชื่อแสดงผล", { exact: true }).inputValue(),
      "แก้ค้างไว้",
    );
    await page.screenshot({ path: `${output}/details-${width}.png` });
    await overflow(page);
    await page
      .getByRole("button", { name: "ปิดรายละเอียดไฟล์", exact: true })
      .click();
    await page.getByRole("button", { name: "ละทิ้ง", exact: true }).click();
    await page
      .getByRole("button", { name: "อัปโหลดไฟล์", exact: true })
      .waitFor();
    await page.screenshot({ path: `${output}/workspace-${width}.png` });
    await renderedChecks(page, width);
    if (width < 768) {
      assert.equal(await page.locator(".mobile-nav button").count(), 3);
      await nav(page, "พื้นที่จัดเก็บ", width);
      await page
        .getByRole("heading", { name: "พื้นที่จัดเก็บ", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "ไฟล์", exact: true }).click();
      await page
        .getByRole("heading", { name: "เอกสารทีม", exact: true })
        .waitFor();
    }
    await nav(page, "ถังขยะ", width);
    await page.getByLabel("หน่วยงาน", { exact: true }).selectOption(hr);
    await page.getByRole("button", { name: "กลับไปไฟล์", exact: true }).click();
    await page
      .getByRole("heading", { name: "เอกสารทีม", exact: true })
      .waitFor();
    await nav(page, "ถังขยะ", width);
    assert.equal(
      await page.getByLabel("หน่วยงาน", { exact: true }).inputValue(),
      hr,
      "Trash scope persists independently",
    );
    await overflow(page);
    assert.deepEqual(f.errors, []);
    reports.push({
      role,
      width,
      checks:
        "scope, independent trash, responsive dock/sheet, plain-text preview, dirty guard, mobile navigation, overflow",
    });
    await f.context.close();
  }
  const zoom = await fixture("mixed", 720, true, 2, 480);
  await zoom.page.emulateMedia({ reducedMotion: "reduce" });
  await zoom.page.getByLabel("หน่วยงาน", { exact: true }).selectOption(it);
  await zoom.page.locator(".filename:visible").first().waitFor();
  await renderedChecks(zoom.page, 720);
  await overflow(zoom.page);
  await zoom.page
    .locator(".app-body")
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  const previewBounds = await zoom.page
    .locator(".files-mobile .secondary")
    .last()
    .boundingBox();
  assert.ok(
    previewBounds.y + previewBounds.height <= 416,
    "Bottom navigation does not hide the last file action at an effective 200% viewport",
  );
  await zoom.page.screenshot({ path: `${output}/effective-zoom-200.png` });
  assert.deepEqual(zoom.errors, []);
  await zoom.context.close();
  reports.push({
    role: "mixed",
    width: 720,
    checks:
      "200%-equivalent effective viewport at 2x scale, reduced motion, scrolling and no overflow",
  });
  const f = await fixture("tenant_admin", 1440),
    { page } = f;
  await page.getByLabel("หน่วยงาน", { exact: true }).selectOption(it);
  await page
    .getByRole("combobox", { name: "โฟลเดอร์", exact: true })
    .selectOption(folder);
  // Mutation validation, explicit move confirmation and draft recovery.
  await page.locator(".filename:visible").first().click();
  await page
    .getByRole("button", { name: "แก้ไขข้อมูลและย้ายไฟล์", exact: true })
    .click();
  const editor = page.locator(".file-details-content");
  await editor.getByLabel("ชื่อแสดงผล", { exact: true }).fill("");
  await editor
    .getByRole("button", { name: "บันทึกข้อมูล", exact: true })
    .click();
  assert.equal(
    await editor
      .getByLabel("ชื่อแสดงผล", { exact: true })
      .getAttribute("aria-invalid"),
    "true",
  );
  await editor.getByLabel("ชื่อแสดงผล", { exact: true }).fill("แก้ไขทดสอบ.txt");
  await editor.getByLabel("คลังหน่วยงาน", { exact: true }).selectOption(hr);
  const beforeMove = f.requests.filter(
    (r) => r.method === "PATCH" && r.path.endsWith("/metadata"),
  ).length;
  await editor
    .getByRole("button", { name: "บันทึกข้อมูล", exact: true })
    .click();
  await page
    .getByRole("dialog", {
      name: "ย้ายเอกสารและเปลี่ยนการมองเห็น?",
      exact: true,
    })
    .waitFor();
  assert.equal(
    f.requests.filter(
      (r) => r.method === "PATCH" && r.path.endsWith("/metadata"),
    ).length,
    beforeMove,
    "Move is never submitted before confirmation",
  );
  f.setMetadataFail();
  await page.getByRole("button", { name: "ย้ายเอกสาร", exact: true }).click();
  await editor.getByText(/พื้นที่หน่วยงานปลายทางไม่พอ/).waitFor();
  assert.equal(
    await editor.getByLabel("ชื่อแสดงผล", { exact: true }).inputValue(),
    "แก้ไขทดสอบ.txt",
  );
  await editor
    .getByRole("button", { name: "บันทึกข้อมูล", exact: true })
    .click();
  f.setSearchFail();
  await page.getByRole("button", { name: "ย้ายเอกสาร", exact: true }).click();
  await page
    .getByRole("heading", { name: "โหลดรายการไฟล์ไม่สำเร็จ", exact: true })
    .waitFor();
  const moved = f.requests.filter(
    (r) => r.method === "PATCH" && r.path.endsWith("/metadata"),
  );
  assert.equal(
    moved.at(-1).body.folderId,
    null,
    "Moving department selects destination root",
  );
  await page.getByRole("button", { name: "ลองใหม่", exact: true }).click();
  await page.getByText("ยังไม่มีเอกสารในตำแหน่งนี้", { exact: true }).waitFor();
  // Folder policy and creation use existing APIs and preserve workspace scope.
  await page
    .getByRole("button", { name: "สิทธิ์โฟลเดอร์", exact: true })
    .click();
  await page
    .getByLabel("การมองเห็น", { exact: true })
    .selectOption("restricted");
  await page
    .getByText(/ยังไม่ได้เลือกผู้ใช้ สมาชิกทั่วไปจะเข้าโฟลเดอร์นี้ไม่ได้/)
    .waitFor();
  await page
    .getByRole("checkbox", {
      name: "editor.fixture@example.invalid",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "บันทึก", exact: true }).click();
  await page
    .getByRole("button", { name: "สร้างโฟลเดอร์", exact: true })
    .click();
  await page.getByLabel("ชื่อโฟลเดอร์", { exact: true }).fill("โฟลเดอร์ใหม่");
  await page.getByRole("button", { name: "สร้าง", exact: true }).click();
  assert.equal(
    f.requests.find((r) => r.method === "POST" && r.path.endsWith("/folders"))
      .body.parentFolderId,
    folder,
  );
  await page.getByRole("heading", { name: "เอกสารทีม", exact: true }).waitFor();
  await page
    .locator(".heading")
    .getByRole("button", { name: "อัปโหลดไฟล์", exact: true })
    .click();
  f.delay();
  const uploads = Array.from({ length: 21 }, (_, i) => ({
    name: i === 0 ? "partial.txt" : i === 1 ? "reject.txt" : `sample-${i}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from("fixture"),
  }));
  await page
    .getByLabel("เลือกไฟล์เพื่ออัปโหลด", { exact: true })
    .setInputFiles(uploads);
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .getByRole("dialog", { name: "อัปโหลดไฟล์", exact: true })
      .count(),
    1,
    "Busy upload cannot be dismissed",
  );
  await page
    .getByText(
      "สำเร็จ 19 · สำเร็จบางส่วน 1 · ไม่สำเร็จ/รอตรวจผล 1 จาก 21 ไฟล์",
      { exact: true },
    )
    .waitFor();
  assert.deepEqual(
    f.requests
      .filter((r) => r.path.endsWith("/upload-intents/batch"))
      .map((r) => r.body.files.length),
    [20, 1],
  );
  await page.screenshot({ path: `${output}/upload-results-1440.png` });
  await page
    .getByRole("button", { name: "ปิดผลการอัปโหลด", exact: true })
    .click();
  await nav(page, "ผู้ใช้และสิทธิ์", 1440);
  await page
    .getByLabel("หน่วยงานสำหรับคำเชิญ", { exact: true })
    .selectOption(it);
  await page.getByRole("button", { name: "เชิญผู้ใช้", exact: true }).click();
  await page
    .getByLabel("อีเมลผู้ใช้", { exact: true })
    .fill("new.fixture@example.invalid");
  await page.getByRole("button", { name: "ส่งคำเชิญ", exact: true }).click();
  assert.equal(
    f.requests.find((r) => r.path.endsWith("/users/invite")).body
      .departmentGrants[0].departmentId,
    it,
  );
  await page.getByRole("button", { name: "แก้สิทธิ์", exact: true }).click();
  await page
    .getByRole("dialog", { name: "แก้สิทธิ์ผู้ใช้", exact: true })
    .getByLabel("สถานะ", { exact: true })
    .selectOption("suspended");
  await page.getByRole("button", { name: "บันทึก", exact: true }).click();
  assert.equal(
    f.requests.find((r) => r.method === "PATCH" && r.path.includes("/users/"))
      .body.status,
    "suspended",
  );
  await nav(page, "Audit Trail", 1440);
  await page
    .getByLabel("ตั้งแต่ (เวลาไทย)", { exact: true })
    .fill("2026-11-03T09:00");
  await page
    .getByLabel("ก่อน (เวลาไทย)", { exact: true })
    .fill("2026-11-03T10:00");
  await page.getByRole("button", { name: "ใช้ตัวกรอง", exact: true }).click();
  await page
    .getByRole("button", { name: "ดูรายละเอียด", exact: true })
    .waitFor();
  assert.equal(
    f.requests.filter((r) => r.path.endsWith("/audit-events")).at(-1).query
      .from,
    "2026-11-03T02:00:00.000Z",
    "Audit wall time is interpreted as Bangkok even on a New York browser",
  );
  await page.getByRole("button", { name: "ดูรายละเอียด", exact: true }).click();
  await page
    .getByRole("button", { name: "คัดลอก Request ID", exact: true })
    .waitFor();
  await page.screenshot({ path: `${output}/audit-detail-1440.png` });
  await page.getByRole("button", { name: "ปิด", exact: true }).click();
  await nav(page, "ถังขยะ", 1440);
  await page.getByRole("button", { name: "กู้คืน", exact: true }).click();
  await page.getByText("ถังขยะว่าง", { exact: true }).waitFor();
  await page.getByRole("button", { name: "กลับไปไฟล์", exact: true }).click();
  await page.locator(".filename:visible").first().click();
  await page.getByRole("button", { name: "ย้ายไปถังขยะ", exact: true }).click();
  const confirmTrash = page.getByRole("dialog", {
    name: "ย้ายไฟล์ไปถังขยะ?",
    exact: true,
  });
  await confirmTrash
    .getByRole("button", { name: "ย้ายไปถังขยะ", exact: true })
    .click();
  await nav(page, "ถังขยะ", 1440);
  await page.getByRole("button", { name: "ลบถาวร", exact: true }).click();
  const purge = page.getByRole("dialog", { name: "ลบไฟล์ถาวร?", exact: true });
  assert.equal(
    await purge
      .getByRole("button", { name: "ยกเลิก", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
    "Destructive dialog initially focuses cancel",
  );
  await purge
    .getByRole("button", { name: "ส่งคำขอลบถาวร", exact: true })
    .click();
  await page.getByText(/ส่งคำขอลบถาวรแล้ว การคืนพื้นที่อาจใช้เวลา/).waitFor();
  await page.screenshot({ path: `${output}/trash-receipt-1440.png` });
  assert.deepEqual(f.errors, []);
  reports.push({
    role: "tenant_admin",
    width: 1440,
    checks:
      "metadata validation/move/draft recovery, folder ACL/create, 21-file batch with partial/denied results, invitation/member edit, audit timezone/details, trash/restore/purge receipt",
  });
  await f.context.close();
  const viewer = await fixture("viewer", 390);
  await viewer.page
    .getByRole("button", { name: "เพิ่มเติม", exact: true })
    .click();
  assert.equal(
    await viewer.page
      .getByRole("button", { name: "พื้นที่จัดเก็บ", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await viewer.page
      .getByRole("button", { name: "ผู้ใช้และสิทธิ์", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await viewer.page
      .getByRole("button", { name: "API keys", exact: true })
      .count(),
    0,
  );
  await viewer.context.close();
  reports.push({
    role: "viewer",
    width: 390,
    checks: "restricted menus hidden",
  });
  const departmentAdmin = await fixture("admin", 390);
  await nav(departmentAdmin.page, "พื้นที่จัดเก็บ", 390);
  await departmentAdmin.page
    .getByRole("heading", { name: "พื้นที่จัดเก็บ", exact: true })
    .waitFor();
  assert.equal(
    await departmentAdmin.page
      .getByRole("button", { name: /^ตั้งโควตา / })
      .count(),
    0,
  );
  await nav(departmentAdmin.page, "ถังขยะ", 390);
  await departmentAdmin.page
    .getByRole("button", { name: "ลบถาวร", exact: true })
    .click();
  await departmentAdmin.page
    .getByRole("dialog", { name: "ลบไฟล์ถาวร?", exact: true })
    .getByRole("button", { name: "ยกเลิก", exact: true })
    .click();
  await departmentAdmin.page
    .getByRole("button", { name: "เพิ่มเติม", exact: true })
    .click();
  assert.equal(
    await departmentAdmin.page
      .getByRole("button", { name: "ผู้ใช้และสิทธิ์", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await departmentAdmin.page
      .getByRole("button", { name: "Audit Trail", exact: true })
      .count(),
    0,
  );
  assert.deepEqual(departmentAdmin.errors, []);
  await departmentAdmin.context.close();
  reports.push({
    role: "department admin",
    width: 390,
    checks:
      "read quota without setting it, purge action, no organization management privileges",
  });
  const management = await fixture("management", 1440);
  await nav(management.page, "API keys", 1440);
  await management.page
    .getByRole("button", { name: "สร้าง API key", exact: true })
    .click();
  await management.page
    .getByLabel("บทบาทคีย์ IT", { exact: true })
    .selectOption("admin");
  await management.page
    .getByRole("button", { name: "สร้าง key", exact: true })
    .click();
  await management.page
    .getByRole("button", { name: "เสร็จสิ้น", exact: true })
    .click();
  await management.page
    .getByRole("button", { name: "ยืนยันปิดโดยยังไม่ได้เก็บ", exact: true })
    .waitFor();
  await management.page
    .getByRole("checkbox", { name: "ฉันจัดเก็บคีย์นี้แล้ว", exact: true })
    .check();
  await management.page
    .getByRole("button", { name: "เสร็จสิ้น", exact: true })
    .click();
  assert.equal(
    await management.page
      .getByRole("dialog", { name: "จัดเก็บ API key", exact: true })
      .count(),
    0,
  );
  assert.deepEqual(management.errors, []);
  await management.context.close();
  reports.push({
    role: "mock management identity",
    width: 1440,
    checks: "conditional key UI, one-time secret close acknowledgement",
  });
  const invitation = await fixture("viewer", 390);
  await invitation.page.goto(`${base}/set-password`);
  await invitation.page.getByLabel("รหัสผ่านใหม่", { exact: true }).waitFor();
  await invitation.page
    .getByLabel("รหัสผ่านใหม่", { exact: true })
    .fill("short");
  await invitation.page
    .getByRole("button", { name: "บันทึกรหัสผ่าน", exact: true })
    .click();
  await invitation.page
    .getByText("รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร", { exact: true })
    .waitFor();
  await invitation.page
    .getByLabel("รหัสผ่านใหม่", { exact: true })
    .fill("a valid fixture password");
  await invitation.page
    .getByRole("button", { name: "บันทึกรหัสผ่าน", exact: true })
    .click();
  await invitation.page
    .getByRole("heading", { name: "ไฟล์ทุกหน่วยงาน", exact: true })
    .waitFor();
  assert.deepEqual(invitation.errors, []);
  await invitation.context.close();
  reports.push({
    role: "invited user",
    width: 390,
    checks:
      "password length, mocked Auth password update, membership before workspace",
  });
  const auth = await fixture("viewer", 390, false);
  await auth.page
    .getByLabel("อีเมล", { exact: true })
    .fill("fixture@example.invalid");
  await auth.page.getByLabel("รหัสผ่าน", { exact: true }).fill("invalid");
  await auth.page
    .getByRole("button", { name: "เข้าสู่ระบบ", exact: true })
    .click();
  await auth.page
    .getByText("อีเมลหรือรหัสผ่านไม่ถูกต้อง", { exact: true })
    .waitFor();
  await auth.page
    .getByLabel("รหัสผ่าน", { exact: true })
    .fill("correct password");
  await auth.page
    .getByRole("button", { name: "เข้าสู่ระบบ", exact: true })
    .click();
  await auth.page
    .getByRole("heading", { name: "ไฟล์ทุกหน่วยงาน", exact: true })
    .waitFor();
  assert.deepEqual(auth.errors, []);
  await auth.context.close();
  reports.push({
    role: "login",
    width: 390,
    checks:
      "invalid credentials, successful Auth SDK login and membership check",
  });
  writeFileSync(
    `${output}/report.json`,
    JSON.stringify({ mocked: true, reports }, null, 2),
  );
  console.log(JSON.stringify(reports, null, 2));
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: `${output}/failure.png` });
    writeFileSync(
      `${output}/failure.txt`,
      await activePage.locator("body").innerText(),
    );
  }
  throw error;
} finally {
  await browser.close();
}
