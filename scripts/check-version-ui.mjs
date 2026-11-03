// Browser plugin not available. Uses an existing Playwright installation via PLAYWRIGHT_MODULE.
// Run against a production/dev server with VERSION_UI_URL (default localhost:3017).
// Auth and APIs are mocked; no real accounts, files or Storage objects are changed.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    "../.quota-reports/ui-runtime/node_modules/playwright",
);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.VERSION_UI_BROWSER ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const base = process.env.VERSION_UI_URL || "http://127.0.0.1:3017";
const userId = "11111111-1111-4111-8111-111111111111",
  fileId = "22222222-2222-4222-8222-222222222222",
  dept = "33333333-3333-4333-8333-333333333333";
const id = (n) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;
const project = new URL(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
).hostname.split(".")[0];
const row = {
  id: fileId,
  displayName: "เอกสารทดสอบประวัติเวอร์ชัน",
  originalName: "sample.txt",
  contentType: "text/plain",
  sizeBytes: "5",
  departmentId: dept,
  department: "IT",
  createdAt: "2026-11-02T01:00:00Z",
  folderId: null,
  tags: [],
};
const version = (n) => ({
  id: id(n),
  versionNumber: n,
  originalName: `ฉบับที่-${n}-ชื่อเอกสารภาษาไทยยาวเพื่อทดสอบการตัดบรรทัด.txt`,
  contentType: "text/plain",
  sizeBytes: "5",
  status: "available",
  createdByKind: "user",
  createdById: userId,
  createdAt: "2026-11-02T01:00:00Z",
  restoredFromVersionId: null,
});
mkdirSync(".next/version-ui", { recursive: true });
try {
  for (const [role, width] of [
    ["editor", 1440],
    ["viewer", 390],
    ["editor", 390],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 950 },
    });
    const session = {
      access_token: `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`,
      refresh_token: "fixture",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
      token_type: "bearer",
      user: {
        id: userId,
        email: "fixture@example.invalid",
        aud: "authenticated",
        app_metadata: {},
        user_metadata: {},
        created_at: "2026-11-02T00:00:00Z",
      },
    };
    await context.addInitScript(
      ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
      {
        key: `sb-${project}-auth-token`,
        value: session,
      },
    );
    let items = [version(3), version(1)],
      current = id(3),
      failList = false,
      conflict = false,
      failComplete = false,
      intents = 0;
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await context.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      const ok = (data) => route.fulfill({ json: { data } });
      if (path.endsWith("/me"))
        return route.fulfill({
          json: {
            userId,
            isTenantAdmin: false,
            scopes: ["files:read", "files:write"],
            departments: [{ id: dept, name: "IT", role }],
          },
        });
      if (path.endsWith("/departments"))
        return ok({ items: [{ id: dept, name: "IT", code: "it", role }] });
      if (path.endsWith("/folders")) return ok({ items: [] });
      if (path.endsWith("/search"))
        return ok({ items: [row], nextCursor: null });
      if (path.endsWith("/versions")) {
        if (failList)
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: "service_unavailable",
                message: "fixture failure",
              },
            },
          });
        return ok({
          items: url.searchParams.has("cursor")
            ? [{ ...version(2), status: "pending_upload" }]
            : items,
          currentVersionId: current,
          nextCursor: url.searchParams.has("cursor") ? null : "2",
        });
      }
      if (path.endsWith("/restore")) {
        if (conflict)
          return route.fulfill({
            status: 409,
            json: { error: { code: "version_conflict" } },
          });
        const restored = { ...version(4), restoredFromVersionId: id(1) };
        items = [restored, ...items];
        current = id(4);
        return route.fulfill({
          status: 201,
          json: { data: { versionNumber: 4, versionId: current } },
        });
      }
      if (path.endsWith("/versions/upload-intents")) {
        intents++;
        return route.fulfill({
          status: 201,
          json: {
            data: { versionId: id(5), signedUrl: `${base}/fixture-storage` },
          },
        });
      }
      if (path.endsWith("/complete")) {
        if (failComplete)
          return route.fulfill({
            status: 503,
            json: { error: { code: "service_unavailable" } },
          });
        items = [version(5), ...items];
        current = id(5);
        return ok({ status: "available" });
      }
      if (path.endsWith("/download-url") || path.endsWith("/preview-url"))
        return ok({
          signedUrl: `${base}/fixture-preview`,
          fileName: "sample.txt",
          contentType: "text/plain",
        });
      return route.fulfill({
        status: 404,
        json: { error: { code: "fixture_unexpected", message: path } },
      });
    });
    await context.route("**/fixture-storage", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return route.fulfill({ status: 200, json: { Key: "fixture" } });
    });
    await context.route("**/fixture-preview", (route) =>
      route.fulfill({ contentType: "text/plain", body: "Fixture preview" }),
    );
    await page.goto(base);
    await page
      .locator(".filename:visible")
      .filter({ hasText: /เอกสารทดสอบประวัติเวอร์ชัน/ })
      .click();
    const tab = page.getByRole("tab", { name: "ประวัติเวอร์ชัน" });
    await page.getByRole("tab", { name: "รายละเอียด", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    assert.equal(
      await tab.getAttribute("aria-selected"),
      "true",
      "Keyboard must open the versions tab",
    );
    await page.getByText("เวอร์ชัน 3", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("tab", { name: "รายละเอียด" })
        .getAttribute("aria-selected"),
      "false",
    );
    await page
      .getByRole("button", { name: "โหลดเวอร์ชันเพิ่ม", exact: true })
      .click();
    await page.getByText("รอยืนยัน", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "ดูตัวอย่างเวอร์ชัน 1", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "ดูตัวอย่างเวอร์ชัน 1", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "ปิดตัวอย่าง" }).click();
    await page
      .getByRole("button", { name: "ดาวน์โหลดเวอร์ชัน 1", exact: true })
      .click();
    await page.getByRole("link", { name: "ดาวน์โหลด sample.txt" }).waitFor();
    if (role === "viewer") {
      assert.equal(
        await page
          .getByRole("button", { name: "อัปโหลดฉบับใหม่", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "กู้คืนเวอร์ชัน 1", exact: true })
          .count(),
        0,
      );
    } else {
      await page
        .getByRole("button", { name: "กู้คืนเวอร์ชัน 1", exact: true })
        .click();
      await page.getByRole("button", { name: "ยกเลิก", exact: true }).click();
      await page
        .getByRole("button", { name: "กู้คืนเวอร์ชัน 1", exact: true })
        .click();
      await page
        .getByRole("button", { name: "ยืนยันกู้คืน", exact: true })
        .click();
      await page.getByText(/กู้คืนแล้ว · สร้างเวอร์ชัน 4/).waitFor();
      conflict = true;
      await page
        .getByRole("button", { name: "กู้คืนเวอร์ชัน 1", exact: true })
        .click();
      await page
        .getByRole("button", { name: "ยืนยันกู้คืน", exact: true })
        .click();
      await page.getByText(/มีการเปลี่ยนเวอร์ชันปัจจุบัน/).waitFor();
      conflict = false;
      await page.locator('input[type="file"]').setInputFiles({
        name: "revised.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("hello"),
      });
      failComplete = true;
      await page
        .getByRole("button", { name: "อัปโหลดฉบับใหม่", exact: true })
        .click();
      await page.setViewportSize({
        width: width === 1440 ? 1024 : 1440,
        height: 900,
      });
      await page
        .getByRole("button", { name: "ตรวจสอบและยืนยันอีกครั้ง", exact: true })
        .waitFor();
      // Wait until the failed attempt has finished its list refresh.
      await page.waitForFunction(
        () =>
          !Array.from(document.querySelectorAll("button")).find((b) =>
            b.textContent.includes("ตรวจสอบและยืนยันอีกครั้ง"),
          )?.disabled,
      );
      failComplete = false;
      await page.setViewportSize({ width, height: 900 });
      await page
        .getByRole("button", { name: "ตรวจสอบและยืนยันอีกครั้ง", exact: true })
        .click();
      await page.getByText("บันทึกเวอร์ชันใหม่แล้ว", { exact: true }).waitFor();
      assert.equal(
        intents,
        1,
        "Retry should complete the existing intent rather than create another",
      );
    }
    await page.locator(".file-details-content").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: `.next/version-ui/${role}-${width}.png`,
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "Page must not overflow horizontally",
    );
    failList = true;
    await page
      .getByRole("button", { name: "โหลดประวัติเวอร์ชันใหม่", exact: true })
      .click();
    await page.locator('.file-versions [role="alert"]').waitFor();
    failList = false;
    await page
      .getByRole("button", { name: "โหลดรายการใหม่", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector('.file-versions [role="alert"]'),
    );
    assert.deepEqual(errors, []);
    console.log(
      `Version UI passed: ${role}, ${width}px, preview/download, pagination, permissions, errors and mutations.`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}
