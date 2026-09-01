/**
 * Split RLE, recovered from Ken Uston's Blackjack/Poker for ColecoVision.
 *
 * Amy container:
 *   u16 payloadOffset (relative to the start of the container)
 *   control stream
 *   payload stream
 *
 * Control bytes:
 *   00       end
 *   01-7F    copy 1..127 payload bytes
 *   81-FF    repeat the next payload byte 1..127 times
 */
export class SplitRLECodec {
  compress(inputData) {
    const input = new Uint8Array(inputData || []);
    const controls = [];
    const payload = [];
    let raw = [];

    const flushRaw = () => {
      let offset = 0;
      while (offset < raw.length) {
        const length = Math.min(127, raw.length - offset);
        controls.push(length);
        payload.push(...raw.slice(offset, offset + length));
        offset += length;
      }
      raw = [];
    };

    for (let index = 0; index < input.length;) {
      let runLength = 1;
      while (index + runLength < input.length && input[index + runLength] === input[index]) runLength += 1;
      if (runLength >= 2) {
        flushRaw();
        let remaining = runLength;
        while (remaining > 0) {
          const length = Math.min(127, remaining);
          controls.push(0x80 | length);
          payload.push(input[index]);
          remaining -= length;
        }
        index += runLength;
      } else {
        raw.push(input[index++]);
        if (raw.length === 127) flushRaw();
      }
    }
    flushRaw();
    controls.push(0);

    const payloadOffset = 2 + controls.length;
    if (payloadOffset > 0xffff) throw new Error("Split RLE control stream exceeds 65535 bytes.");
    return Uint8Array.from([
      payloadOffset & 0xff,
      payloadOffset >>> 8,
      ...controls,
      ...payload
    ]);
  }

  decompress(compressedData) {
    const input = new Uint8Array(compressedData || []);
    if (input.length < 3) throw new Error("Invalid Split RLE container: missing header or terminator.");
    const payloadOffset = input[0] | (input[1] << 8);
    if (payloadOffset < 3 || payloadOffset > input.length) throw new Error("Invalid Split RLE payload offset.");

    const output = [];
    let controlIndex = 2;
    let payloadIndex = payloadOffset;
    while (controlIndex < payloadOffset) {
      const control = input[controlIndex++];
      if (control === 0) return Uint8Array.from(output);
      const length = control & 0x7f;
      if (!length) throw new Error("Invalid Split RLE zero-length packet.");
      if (control & 0x80) {
        if (payloadIndex >= input.length) throw new Error("Invalid Split RLE run: missing payload byte.");
        const value = input[payloadIndex++];
        for (let count = 0; count < length; count += 1) output.push(value);
      } else {
        if (payloadIndex + length > input.length) throw new Error("Invalid Split RLE literal: truncated payload.");
        for (let count = 0; count < length; count += 1) output.push(input[payloadIndex++]);
      }
    }
    throw new Error("Invalid Split RLE container: missing terminator.");
  }
}
