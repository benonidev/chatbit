// Builds dist/assets/js/lib/crypto-bundle.js from the pinned versions in package.json:
//   npm ci --ignore-scripts && npm run build
// HPKE (RFC 9180, X25519 in pure JS — no dependency on WebCrypto X25519 support) and Ed25519.
import {build} from "esbuild";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));
const versions = Object.entries(pkg.dependencies).map(([name, v]) => `${name}@${v}`).join(", ");
const out = new URL("../../dist/assets/js/lib/crypto-bundle.js", import.meta.url).pathname;

await build({
    entryPoints: [new URL("./entry.mjs", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    minify: true,
    target: "es2022",
    legalComments: "none",
    banner: {js: `// ChatBit crypto bundle — ${versions} (MIT). Built by tools/crypto-bundle, do not edit.`},
    outfile: out,
});

const sha = createHash("sha512").update(readFileSync(out)).digest("base64");
console.log(`${out}\nsha512-${sha}`);
