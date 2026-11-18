import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packagePath = require.resolve("pdfjs-dist/package.json");
const source = dirname(packagePath);
const { version } = require(packagePath);
const target = fileURLToPath(new URL(`../public/pdfjs/${version}/`, import.meta.url));

mkdirSync(target, { recursive: true });
cpSync(join(source, "build", "pdf.worker.min.mjs"), join(target, "pdf.worker.min.mjs"));
for (const asset of ["cmaps", "standard_fonts", "iccs"]) {
    cpSync(join(source, asset), join(target, asset), { recursive: true });
}
cpSync(join(source, "LICENSE"), join(target, "LICENSE"));
