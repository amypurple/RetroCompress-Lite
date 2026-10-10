import assert from "node:assert/strict";
import crypto from "node:crypto";
import { MSC1Codec } from "../js/codecs/msc1.js";

const codec = new MSC1Codec();
const cases = [
  new Uint8Array(),
  new Uint8Array([0]),
  new Uint8Array([1, 2, 3, 4]),
  new Uint8Array(Array.from({ length: 4096 }, (_, i) => i & 0xff)),
  new Uint8Array(Array.from({ length: 1024 }, (_, i) => [1, 2, 3, 4][i & 3]))
];
for (let length = 1; length <= 2048; length += 31) {
  cases.push(new Uint8Array(crypto.randomBytes(length)));
}
for (const input of cases) assert.deepEqual(codec.decompress(codec.compress(input)), input);
assert.throws(() => codec.decompress(new Uint8Array([4, 1, 2])), /truncated/);
assert.throws(() => codec.decompress(new Uint8Array([0x84, 0, 0])), /invalid offset/);
assert.throws(() => codec.decompress(new Uint8Array([1, 7])), /no end marker/);
console.log(`MSC1 codec PASS (${cases.length} inputs)`);
