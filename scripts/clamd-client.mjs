import { createConnection } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";

export function scanError(code, permanent = false) {
    return Object.assign(new Error(code), { code, permanent });
}

async function exchange(address, command, signal, send) {
    const socket = createConnection({ ...address, signal });
    let finished = false;
    const reply = new Promise((resolve, reject) => {
        let text = "";
        socket.on("error", reject);
        socket.on("close", () => { if (!finished) reject(scanError("scanner_disconnected")); });
        socket.on("data", (data) => {
            text += data.toString("utf8");
            if (text.length > 2048) {
                reject(scanError("scanner_invalid_reply"));
                socket.destroy();
            } else if (text.includes("\0")) {
                finished = true;
                resolve(text.slice(0, text.indexOf("\0")));
            }
        });
    });
    // A remote close may precede the completion of a write or source read.
    reply.catch(() => undefined);
    const write = (bytes) => new Promise((resolve, reject) => socket.write(bytes, (error) => error ? reject(error) : resolve()));
    try {
        await once(socket,"connect",{signal});
        await write(Buffer.from(`z${command}\0`));
        if (send) await send(write);
        return await reply;
    } finally { socket.destroy(); }
}

export function validateSignatureAge(version, now = Date.now()) {
    const parsed = /^ClamAV [^/]+\/(\d+)\/(.+)$/.exec(version);
    const timestamp = parsed ? Date.parse(`${parsed[2]} UTC`) : NaN;
    if (!Number.isFinite(timestamp) || timestamp > now + 300_000 || now - timestamp > 72 * 3_600_000)
        throw scanError("scanner_signatures_stale");
}

export function interpretScanReply(reply) {
    if (reply === "stream: OK") return "clean";
    if (/^stream: Heuristics\.(?:Limits\.Exceeded|Encrypted)(?:[.\w-]*) FOUND$/.test(reply)) return "unscannable";
    if (/^stream: [\w.()+ -]+ FOUND$/.test(reply)) return "infected";
    if (/^INSTREAM size limit exceeded\. ERROR$/.test(reply)) return "unscannable";
    throw scanError("scanner_invalid_reply");
}

export async function scanStream(address, openBody, expectedBytes, attemptSignal, timeoutMs = 90_000) {
    const signal = AbortSignal.any([attemptSignal, AbortSignal.timeout(timeoutMs)]);
    validateSignatureAge(await exchange(address,"VERSION",signal));
    let sent = 0;
    const hash = createHash("sha256");
    const reply = await exchange(address,"INSTREAM",signal,async (write) => {
        const body = await openBody(signal);
        for await (const chunk of body) {
            signal.throwIfAborted();
            sent += chunk.byteLength;
            if (sent > expectedBytes) throw scanError("object_changed",true);
            hash.update(chunk);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(chunk.byteLength);
            if (chunk.byteLength) {
                await write(size);
                await write(chunk);
            }
        }
        if (sent !== expectedBytes) throw scanError("object_changed",true);
        await write(Buffer.alloc(4));
    });
    const verdict = interpretScanReply(reply);
    if (verdict === "clean") validateSignatureAge(await exchange(address,"VERSION",signal));
    return { verdict, sha256:hash.digest("hex") };
}
