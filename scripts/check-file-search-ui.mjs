// Browser plugin not available. Uses Playwright/Chrome with mocked Auth and APIs.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    "../.quota-reports/ui-runtime/node_modules/playwright",
);
const base = process.env.SEARCH_UI_URL || "http://127.0.0.1:3017",
  output = ".quota-reports/search-ui";
mkdirSync(output, { recursive: true });
const project = new URL(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
).hostname.split(".")[0];
const dept = "33333333-3333-4333-8333-333333333333",
  ba = "44444444-4444-4444-8444-444444444444",
  folder = "55555555-5555-4555-8555-555555555555";
const id = (n) => `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
const file = (n, name, departmentId = dept) => ({
  id: id(n),
  originalName: `${name}.pdf`,
  displayName: name,
  contentType: "application/pdf",
  sizeBytes: "1200",
  folderId: null,
  departmentId,
  department: departmentId === ba ? "BA" : "IT",
  tags: ["Finance", "2569"],
  createdAt: "2026-11-03T00:00:00.000Z",
});
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.SEARCH_UI_BROWSER ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
        viewport: { width, height: 900 },
      }),
      userId = "11111111-1111-4111-8111-111111111111";
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
        created_at: "2026-11-03T00:00:00Z",
      },
    };
    await context.addInitScript(
      ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
      {
        key: `sb-${project}-auth-token`,
        value: session,
      },
    );
    const page = await context.newPage(),
      errors = [],
      consoleIssues = [],
      requests = [];
    let releaseSlow,
      releaseScope,
      failed = false;
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        consoleIssues.push(message.text());
    });
    const grants = [
      { id: dept, name: "IT", code: "it", role: "viewer" },
      { id: ba, name: "BA", code: "ba", role: "viewer" },
    ];
    await context.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname,
        ok = (data) => route.fulfill({ json: { data } });
      if (path.endsWith("/me"))
        return route.fulfill({
          json: {
            userId,
            isTenantAdmin: false,
            scopes: ["files:read", "files:write"],
            departments: grants,
          },
        });
      if (path.endsWith("/departments")) return ok({ items: grants });
      if (path.endsWith("/folders"))
        return ok({
          items:
            url.searchParams.get("departmentId") === dept &&
            !url.searchParams.has("parentFolderId")
              ? [
                  {
                    id: folder,
                    name: "เอกสารทีม",
                    departmentId: dept,
                    parentFolderId: null,
                  },
                ]
              : [],
        });
      if (path.endsWith("/search")) {
        const body = route.request().postDataJSON();
        requests.push(body);
        if (body.q === "งบ 2569")
          return ok({
            items: [
              file(
                body.cursor ? 2 : 1,
                body.cursor
                  ? "งบสรุปประจำปี 2569"
                  : "รายงานงบการเงินและรายละเอียดผลประกอบการประจำปี 2569",
              ),
            ],
            nextCursor: body.cursor ? null : "budget-next",
          });
        if (body.q === "ไม่พบผล") return ok({ items: [], nextCursor: null });
        if (body.q === "ล้มเหลว" && !failed) {
          failed = true;
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: "service_unavailable",
                message: "Fixture search failed",
              },
            },
          });
        }
        if (body.q === "เก่า") {
          await new Promise((resolve) => {
            releaseSlow = resolve;
          });
          return ok({
            items: [file(7, "ผลเก่าที่ต้องถูกละทิ้ง")],
            nextCursor: null,
          });
        }
        if (body.q === "ค้าง" && body.departmentId !== ba) {
          await new Promise((resolve) => {
            releaseScope = resolve;
          });
          return ok({
            items: [file(8, "ผล IT เก่าที่ต้องไม่แสดง")],
            nextCursor: null,
          });
        }
        if (body.departmentId === ba)
          return ok({
            items: [file(9, "เอกสาร BA ที่ถูกต้อง", ba)],
            nextCursor: null,
          });
        return ok({
          items: [file(3, body.q ? `ผลค้นหา ${body.q}` : "เอกสารเริ่มต้น")],
          nextCursor: null,
        });
      }
      return route.fulfill({
        status: 404,
        json: { error: { code: "unexpected_mock_route" } },
      });
    });
    await page.goto(base);
    assert.match(await page.title(), /EFIN DMS/);
    await page
      .locator(".filename:visible")
      .filter({ hasText: "เอกสารเริ่มต้น" })
      .waitFor();
    const keyword = page.getByLabel("ค้นหาชื่อไฟล์หรือ tags", { exact: true }),
      form = page.locator(".file-keyword-form");
    const before = requests.length;
    await keyword.fill("  งบ  2569 ");
    await page.waitForTimeout(150);
    assert.equal(requests.length, before, "Typing does not query the server");
    await keyword.press("Enter");
    await page
      .locator(".filename:visible")
      .filter({ hasText: /รายงานงบการเงินและรายละเอียด/ })
      .waitFor();
    assert.equal(requests.at(-1).q, "งบ 2569");
    assert.equal(requests.at(-1).cursor ?? null, null);
    await page.screenshot({ path: `${output}/file-search-${width}.png` });
    await keyword.fill("ยังไม่กดค้นหา");
    await page
      .getByRole("button", { name: "โหลดไฟล์เพิ่ม", exact: true })
      .click();
    await page
      .locator(".filename:visible")
      .filter({ hasText: /งบสรุปประจำปี/ })
      .waitFor();
    assert.equal(requests.at(-1).q, "งบ 2569");
    assert.equal(requests.at(-1).cursor, "budget-next");
    const count = requests.length;
    await keyword.fill(Array(11).fill("คำ").join(" "));
    await form.getByRole("button", { name: "ค้นหา", exact: true }).click();
    assert.equal(requests.length, count);
    assert.equal(await keyword.getAttribute("aria-invalid"), "true");
    assert.equal(
      await keyword.evaluate((el) => el === document.activeElement),
      true,
    );
    await keyword.fill("งบ 2569");
    await page.getByRole("button", { name: /^ตัวกรอง/ }).click();
    const filters = page.getByRole("dialog", {
      name: "ตัวกรองไฟล์",
      exact: true,
    });
    await filters.getByLabel("Tag แบบตรงค่า", { exact: true }).fill("Finance");
    await filters
      .getByLabel("ชนิดไฟล์ (MIME)", { exact: true })
      .fill("application/pdf");
    await filters
      .getByRole("button", { name: "ใช้ตัวกรอง", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".files-desktop")?.getAttribute("aria-busy") ===
        "false",
    );
    assert.equal(requests.at(-1).q, "งบ 2569");
    assert.equal(requests.at(-1).tag, "Finance");
    assert.equal(requests.at(-1).contentType, "application/pdf");
    assert.equal(requests.at(-1).cursor ?? null, null);
    await page.getByRole("button", { name: "ล้างคำค้น", exact: true }).click();
    await page
      .locator(".filename:visible")
      .filter({ hasText: "เอกสารเริ่มต้น" })
      .waitFor();
    assert.equal(requests.at(-1).q, undefined);
    assert.equal(requests.at(-1).tag, "Finance");
    await page
      .getByRole("button", { name: "ล้างทั้งหมด", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".files-desktop")?.getAttribute("aria-busy") ===
        "false",
    );
    assert.equal(requests.at(-1).q, undefined);
    assert.equal(requests.at(-1).tag, undefined);
    if (width === 1440)
      await page
        .locator(".sidebar")
        .getByRole("button", { name: "IT Viewer", exact: true })
        .click();
    else await page.getByLabel("หน่วยงาน", { exact: true }).selectOption(dept);
    await page
      .getByRole("combobox", { name: "โฟลเดอร์", exact: true })
      .selectOption(folder);
    await keyword.fill("งบ 2569");
    await keyword.press("Enter");
    await page
      .locator(".filename:visible")
      .filter({ hasText: /รายงานงบการเงินและรายละเอียด/ })
      .waitFor();
    assert.equal(requests.at(-1).departmentId, dept);
    assert.equal(requests.at(-1).folderId, folder);
    await page
      .getByRole("button", { name: "ล้างทั้งหมด", exact: true })
      .click();
    await page
      .locator(".filename:visible")
      .filter({ hasText: "เอกสารเริ่มต้น" })
      .waitFor();
    assert.equal(requests.at(-1).departmentId, dept);
    assert.equal(requests.at(-1).folderId, folder);
    await keyword.fill("ไม่พบผล");
    await keyword.press("Enter");
    await page
      .getByText("ไม่พบเอกสารตามเงื่อนไขนี้", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "ล้างเงื่อนไขค้นหา", exact: true })
      .click();
    await page
      .locator(".filename:visible")
      .filter({ hasText: "เอกสารเริ่มต้น" })
      .waitFor();
    await keyword.fill("ล้มเหลว");
    await keyword.press("Enter");
    await page
      .getByRole("heading", { name: "โหลดรายการไฟล์ไม่สำเร็จ", exact: true })
      .waitFor();
    await keyword.fill("ยังไม่ส่งคำใหม่");
    await page.getByRole("button", { name: "ลองใหม่", exact: true }).click();
    await page
      .locator(".filename:visible")
      .filter({ hasText: "ผลค้นหา ล้มเหลว" })
      .waitFor();
    assert.equal(requests.at(-1).q, "ล้มเหลว");
    await keyword.fill("เก่า");
    await keyword.press("Enter");
    await page.waitForTimeout(100);
    assert.equal(typeof releaseSlow, "function");
    await keyword.fill("ใหม่");
    await keyword.press("Enter");
    await page
      .locator(".filename:visible")
      .filter({ hasText: "ผลค้นหา ใหม่" })
      .waitFor();
    releaseSlow();
    await page.waitForTimeout(150);
    assert.equal(
      await page.getByText("ผลเก่าที่ต้องถูกละทิ้ง", { exact: true }).count(),
      0,
    );
    await keyword.fill("ค้าง");
    await keyword.press("Enter");
    await page.waitForTimeout(100);
    assert.equal(typeof releaseScope, "function");
    if (width === 1440)
      await page
        .locator(".sidebar")
        .getByRole("button", { name: "BA Viewer", exact: true })
        .click();
    else await page.getByLabel("หน่วยงาน", { exact: true }).selectOption(ba);
    await page
      .locator(".filename:visible")
      .filter({ hasText: "เอกสาร BA ที่ถูกต้อง" })
      .waitFor();
    releaseScope();
    await page.waitForTimeout(150);
    assert.equal(
      await page.getByText("ผล IT เก่าที่ต้องไม่แสดง", { exact: true }).count(),
      0,
    );
    assert.equal(requests.at(-1).folderId, undefined);
    assert.equal(requests.at(-1).departmentId, ba);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "No horizontal viewport overflow",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(
      consoleIssues.filter(
        (message) =>
          !/^Failed to load resource: the server responded with a status of 503 /.test(
            message,
          ),
      ),
      [],
    );
    assert.equal(await page.locator("nextjs-portal").count(), 0);
    console.log(
      `File search UI passed: ${width}px, Viewer, explicit submit, applied/draft terms, load more, filters/clear, scope, empty/error/retry, validation focus, stale response protection, no overflow/overlay/console errors.`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}
