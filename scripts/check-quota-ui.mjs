// Browser plugin not available: use isolated Playwright + installed Chrome.
// All Auth/API responses are mocked; no real user or storage data is modified.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "../.quota-reports/ui-runtime/node_modules/playwright");
const base = process.env.QUOTA_UI_URL || "http://localhost:3017",
    output = ".quota-reports/ui";
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.QUOTA_UI_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL).hostname.split(".")[0];
const uuid = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const name = "IT — แผนกเทคโนโลยีสารสนเทศและการจัดการเอกสารสำหรับองค์กร";
function quota(n, label, used = "20000000", reserved = "10000000", limit = "100000000", ready = true) {
    const committed = (BigInt(used) + BigInt(reserved)).toString();
    return {
        departmentId: uuid(n),
        departmentName: label,
        accountingStatus: ready ? "ready" : "pending_backfill",
        limitBytes: limit,
        usedBytes: ready ? used : null,
        reservedBytes: ready ? reserved : null,
        committedBytes: ready ? committed : null,
        availableBytes:
            ready && limit !== null ? (BigInt(limit) > BigInt(committed) ? BigInt(limit) - BigInt(committed) : 0n).toString() : null,
        overQuota: ready ? limit !== null && BigInt(committed) > BigInt(limit) : null,
        revision: "7",
        canManageQuota: true,
    };
}
try {
    for (const [role, width] of [
        ["tenant_admin", 1440],
        ["tenant_admin", 390],
        ["editor", 390],
        ["viewer", 390],
    ]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const userId = "11111111-1111-4111-8111-111111111111",
            isAdmin = role === "tenant_admin";
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
        await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
            key: `sb-${project}-auth-token`,
            value: session,
        });
        let rows = [
            quota(1, name),
            quota(2, "ฝ่ายบัญชี", "85000000", "0"),
            quota(3, "ฝ่ายบุคคล", "100000000", "0"),
            quota(4, "ฝ่ายวิจัย", "110000000", "0"),
            quota(5, "General", "0", "0", null),
            quota(6, "หน่วยงานใหม่", "0", "0", null, false),
        ];
        rows = rows.map((row) => ({ ...row, canManageQuota: isAdmin }));
        let failList = width === 390 && isAdmin,
            conflict = false,
            failSave = false,
            empty = false,
            forbidden = false,
            requests = [];
        const page = await context.newPage(),
            errors = [],
            consoleIssues = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
            if (["error", "warning"].includes(message.type())) consoleIssues.push(message.text());
        });
        const grants = rows.map((row) => ({
            id: row.departmentId,
            name: row.departmentName,
            code: row.departmentId,
            role: isAdmin ? "admin" : role,
        }));
        await context.route("**/api/v1/**", async (route) => {
            const url = new URL(route.request().url()),
                path = url.pathname;
            const ok = (data) => route.fulfill({ json: { data } }),
                fail = (status, code) => route.fulfill({ status, json: { error: { code, message: "Fixture failure" } } });
            if (path.endsWith("/me"))
                return route.fulfill({
                    json: {
                        userId,
                        isTenantAdmin: isAdmin,
                        scopes: ["files:read", "files:write", ...(isAdmin ? ["departments:manage"] : [])],
                        departments: grants,
                    },
                });
            if (path.endsWith("/departments")) return ok({ items: grants });
            if (path.endsWith("/search") || path.endsWith("/folders")) return ok({ items: [], nextCursor: null });
            if (path.endsWith("/storage-quotas")) {
                if (failList) {
                    failList = false;
                    return fail(503, "service_unavailable");
                }
                if (forbidden) return fail(403, "department_quota_forbidden");
                return ok({ items: empty ? [] : rows });
            }
            if (path.endsWith("/storage-quota")) {
                const body = route.request().postDataJSON();
                requests.push(body);
                const row = rows.find((r) => path.includes(r.departmentId));
                if (conflict) {
                    conflict = false;
                    row.revision = (BigInt(row.revision) + 1n).toString();
                    return fail(409, "quota_revision_conflict");
                }
                if (failSave) {
                    failSave = false;
                    return fail(503, "service_unavailable");
                }
                assert.equal(body.expectedRevision, row.revision);
                row.limitBytes = body.limitBytes;
                row.revision = (BigInt(row.revision) + 1n).toString();
                row.availableBytes = body.limitBytes === null ? null : (BigInt(body.limitBytes) - BigInt(row.committedBytes)).toString();
                return ok(row);
            }
            return fail(404, "unexpected_mock_route");
        });
        await page.goto(base);
        assert.match(await page.title(), /EFIN DMS/);
        await page.getByRole("heading", { level: 1, name: "ไฟล์ทุกหน่วยงาน" }).waitFor();
        if (role === "viewer") {
            assert.equal(await page.getByRole("button", { name: "พื้นที่", exact: true }).count(), 0);
            assert.equal(await page.getByRole("button", { name: "พื้นที่จัดเก็บ", exact: true }).count(), 0);
        } else {
            await page.getByRole("button", { name: width === 1440 ? "พื้นที่จัดเก็บ" : "พื้นที่", exact: true }).click();
            await page.getByRole("heading", { level: 1, name: "พื้นที่จัดเก็บ" }).waitFor();
            if (width === 390 && isAdmin) {
                await page.getByRole("button", { name: "ลองใหม่", exact: true }).waitFor();
                assert.equal(
                    await page.getByText("ยังไม่มีหน่วยงานที่ดูพื้นที่ได้", { exact: true }).count(),
                    0,
                    "An API error is not an empty result",
                );
                await page.getByRole("button", { name: "ลองใหม่", exact: true }).click();
            }
            await page
                .locator(width === 1440 ? ".quota-desktop" : ".quota-mobile")
                .getByText(name, { exact: true })
                .waitFor();
            assert.equal(
                await page
                    .locator(".quota-page")
                    .innerText()
                    .then((t) => t.includes("รอตรวจสอบยอดพื้นที่")),
                true,
            );
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "No viewport overflow");
            assert.equal(await page.locator(width === 1440 ? ".sidebar button.nav.active" : ".mobile-nav button.active").count(), 1);
            await page.screenshot({ path: `${output}/quotas-${role}-${width}.png` });
            await page.getByLabel("หน่วยงาน", { exact: true }).selectOption(uuid(5));
            assert.equal(await page.locator(width === 1440 ? ".quota-desktop tbody tr" : ".quota-mobile article").count(), 1);
            await page.getByLabel("หน่วยงาน", { exact: true }).selectOption("");
            if (!isAdmin) {
                assert.equal(await page.getByRole("button", { name: /^ตั้งโควตา / }).count(), 0);
            } else {
                const trigger = page.getByRole("button", { name: `ตั้งโควตา ${name}`, exact: true });
                await trigger.click();
                const dialog = page.getByRole("dialog"),
                    input = dialog.getByLabel("จำนวนพื้นที่", { exact: true });
                await input.waitFor();
                assert.equal(await input.inputValue(), "100");
                await input.fill("100.000001");
                await dialog.getByLabel("หน่วย", { exact: true }).selectOption("GB");
                assert.equal(await input.inputValue(), "0.100000001", "Unit changes retain exact bytes");
                await dialog.getByRole("button", { name: "บันทึกโควตา", exact: true }).focus();
                await page.keyboard.press("Tab");
                assert.equal(
                    await dialog.evaluate((el) => el.contains(document.activeElement)),
                    true,
                    "Keyboard focus stays inside the dialog",
                );
                await dialog.getByLabel("หน่วย", { exact: true }).selectOption("MB");
                await input.fill("1");
                await dialog.getByLabel("หน่วย", { exact: true }).selectOption("bytes");
                await dialog.getByRole("button", { name: "บันทึกโควตา", exact: true }).click();
                assert.equal(await input.getAttribute("aria-invalid"), "true");
                assert.equal(requests.length, 0);
                await dialog.getByLabel("หน่วย", { exact: true }).selectOption("GB");
                await input.fill("2");
                await input.blur();
                await page.screenshot({ path: `${output}/quota-dialog-${width}.png` });
                conflict = true;
                await dialog.getByRole("button", { name: "บันทึกโควตา", exact: true }).click();
                await dialog.getByText(/ยอดพื้นที่หรือเพดานเปลี่ยนแล้ว/).waitFor();
                assert.equal(await input.inputValue(), "2");
                assert.equal(requests.length, 1);
                failSave = true;
                await dialog.getByRole("button", { name: "บันทึกโควตา", exact: true }).click();
                await dialog.getByText("ยังบันทึกไม่ได้", { exact: true }).waitFor();
                assert.equal(await input.inputValue(), "2");
                assert.equal(requests.length, 2);
                await dialog.getByRole("button", { name: "บันทึกโควตา", exact: true }).click();
                await dialog.waitFor({ state: "hidden" });
                assert.equal(requests[2].limitBytes, "2000000000");
                assert.equal(requests[2].expectedRevision, "8");
                await page.getByText(`บันทึกโควตา ${name} แล้ว`, { exact: true }).waitFor();
                await trigger.click();
                await dialog.getByRole("radio", { name: "ไม่จำกัด", exact: true }).check();
                await dialog.getByRole("button", { name: "บันทึกโควตา", exact: true }).click();
                await dialog.waitFor({ state: "hidden" });
                assert.equal(requests.at(-1).limitBytes, null);
                await trigger.click();
                await page.keyboard.press("Escape");
                await dialog.waitFor({ state: "hidden" });
                await page.waitForTimeout(100);
                assert.equal(await trigger.evaluate((el) => el === document.activeElement), true, "Dialog restores focus");
                empty = true;
                await page.getByRole("button", { name: "รีเฟรชพื้นที่", exact: true }).click();
                await page.getByText("ยังไม่มีหน่วยงานที่ดูพื้นที่ได้", { exact: true }).waitFor();
                empty = false;
                forbidden = true;
                await page.getByRole("button", { name: "รีเฟรชพื้นที่", exact: true }).click();
                await page.getByText(/คุณไม่มีสิทธิ์ดูหรือจัดการพื้นที่จัดเก็บ/).waitFor();
                assert.equal(await page.getByRole("button", { name: /^ตั้งโควตา / }).count(), 0, "Revoked permissions clear stale actions");
            }
        }
        assert.deepEqual(errors, [], "No uncaught browser errors");
        assert.deepEqual(
            consoleIssues.filter(
                (message) => !/^Failed to load resource: the server responded with a status of (403|409|503) /.test(message),
            ),
            [],
            "No console errors/warnings except intentionally mocked 403/409/503 responses",
        );
        assert.equal(await page.locator("nextjs-portal").count(), 0, "No Next error overlay");
        console.log(
            `Quota UI passed: ${role}, ${width}px; page identity, nonblank, no overlay/errors, responsive/filter/permissions${isAdmin ? ", validation/conflict/retry/save/unlimited/dialog focus/error/empty" : ""}.`,
        );
        await context.close();
    }
} finally {
    await browser.close();
}
