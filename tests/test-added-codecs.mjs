import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const load = async (name) => import(pathToFileURL(resolve(root, "js", "codecs", name)).href);
const { APLibCodec } = await load("aplib.js");
const { ZX0Codec } = await load("zx0.js");
const { ZX1Codec } = await load("zx1.js");
const { ZX2Codec } = await load("zx2.js");
const { ZX0ClassicCodec } = await load("zx0classic.js");
const { SplitRLECodec } = await load("splitrle.js");
const { MegaLZCodec } = await load("megalz.js");

let seed = 0x41c64e6d;
const randomBytes = (length) => {
    const result = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        result[index] = seed >>> 24;
    }
    return result;
};

const cases = [
    new Uint8Array(),
    Uint8Array.of(0),
    Uint8Array.of(1, 2, 3, 4, 5),
    Uint8Array.from({ length: 400 }, () => 0x5a),
    Uint8Array.from({ length: 768 }, (_, index) => index & 31),
    randomBytes(1024)
];

for (const [name, codec] of [
    ["aPLib", new APLibCodec()],
    ["ZX0 modern", new ZX0Codec()],
    ["ZX1", new ZX1Codec()],
    ["ZX2", new ZX2Codec()],
    ["ZX0 Classic", new ZX0ClassicCodec()],
    ["MegaLZ", new MegaLZCodec()],
    ["SplitRLE", new SplitRLECodec()]
]) {
    for (const input of cases) {
        const packed = await codec.compress(input);
        const unpacked = await codec.decompress(packed);
        assert.deepEqual(unpacked, input, `${name} round-trip failed for ${input.length} bytes`);
    }
    console.log(`${name}: ${cases.length} round-trip cases PASS`);
}

const modern = new ZX0Codec();
const classic = new ZX0ClassicCodec();
const formatProbe = Uint8Array.from({ length: 512 }, (_, index) => (index * 13) & 0xff);
const modernStream = await modern.compress(formatProbe);
const classicStream = await classic.compress(formatProbe);
assert.notDeepEqual(modernStream, classicStream, "ZX0 v1 and v2 streams must remain distinguishable");

const split = new SplitRLECodec();
assert.throws(() => split.decompress(Uint8Array.of(3, 0, 1)), /truncated/);
const aplib = new APLibCodec();
assert.throws(() => aplib.decompress(Uint8Array.of(1, 0x80)), /Truncated|Invalid/);

console.log("Added codec validation PASS");
