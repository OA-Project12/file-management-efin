import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";
import { scanStream } from "../scripts/clamd-client.mjs";

const body = Buffer.from("fixture file bytes");

async function scanner(t, { ageHours = 0, verdict = "stream: OK" } = {}) {
    const received = [];
    const sockets = new Set();
    const server = createServer(socket => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        let command;
        let buffer = Buffer.alloc(0);
        socket.on("data", data => {
            buffer = Buffer.concat([buffer, data]);
            if (!command) {
                const end = buffer.indexOf(0);
                if (end === -1) return;
                command = buffer.subarray(0, end).toString();
                buffer = buffer.subarray(end + 1);
                if (command === "zVERSION") {
                    const date = new Date(Date.now() - ageHours * 3_600_000);
                    socket.end(`ClamAV 1.4.4/1234/${date.toUTCString().replace(" GMT", "")}\0`);
                    return;
                }
                assert.equal(command, "zINSTREAM");
            }
            while (buffer.length >= 4) {
                const size = buffer.readUInt32BE();
                if (buffer.length < size + 4) return;
                if (size === 0) {
                    if (verdict) socket.end(`${verdict}\0`);
                    return;
                }
                received.push(buffer.subarray(4, size + 4));
                buffer = buffer.subarray(size + 4);
            }
        });
    });
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    return { address: { host: "127.0.0.1", port: server.address().port }, received };
}

test("INSTREAM sends every chunk with network byte framing and hashes the exact bytes", async t => {
    const { address, received } = await scanner(t);
    const result = await scanStream(address, () => [body.subarray(0, 3), body.subarray(3)], body.length, new AbortController().signal);
    assert.deepEqual(received.map(chunk => chunk.length), [3, body.length - 3]);
    assert.deepEqual(Buffer.concat(received), body);
    assert.deepEqual(result, { verdict: "clean", sha256: createHash("sha256").update(body).digest("hex") });
});

test("INSTREAM distinguishes infection, engine limits and encrypted documents", async t => {
    for (const [reply, expected] of [
        ["stream: Eicar-Test-Signature FOUND", "infected"],
        ["stream: Heuristics.Limits.Exceeded.MaxScanSize FOUND", "unscannable"],
        ["stream: Heuristics.Encrypted.PDF FOUND", "unscannable"],
    ]) {
        const { address } = await scanner(t, { verdict: reply });
        const { verdict } = await scanStream(address, () => [body], body.length, new AbortController().signal);
        assert.equal(verdict, expected);
    }
});

test("stale signatures, short/oversized objects and a silent daemon cannot return clean", async t => {
    const signal = new AbortController().signal;
    const stale = await scanner(t, { ageHours: 73 });
    await assert.rejects(scanStream(stale.address, () => assert.fail("opened a stale scan"), body.length, signal),
        { code: "scanner_signatures_stale" });
    const current = await scanner(t);
    await assert.rejects(scanStream(current.address, () => [body], body.length + 1, signal), { code: "object_changed" });
    await assert.rejects(scanStream(current.address, () => [body], body.length - 1, signal), { code: "object_changed" });
    const silent = await scanner(t, { verdict: null });
    await assert.rejects(scanStream(silent.address, () => [body], body.length, signal, 250));
});
