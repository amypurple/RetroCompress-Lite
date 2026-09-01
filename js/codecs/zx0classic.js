import { ZX0Codec } from "./zx0.js";

/**
 * ZX0 Classic v1 stream wrapper.
 *
 * The shared ZX0 engine already implements both stream generations. This
 * wrapper makes the classic format explicit so files are not silently mixed
 * with the modern inverted ZX0 v2 bitstream.
 */
export class ZX0ClassicCodec extends ZX0Codec {
    async compress(data, options = {}) {
        return super.compress(data, { ...options, classic: true, backwards: false });
    }

    async decompress(data, options = {}) {
        return super.decompress(data, { ...options, classic: true, backwards: false });
    }
}
