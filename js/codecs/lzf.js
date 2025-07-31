/**
 * LZF-Style Compression Codec
 * This is a simplified, educational implementation demonstrating the core principles of LZF.
 * It uses an optimal parser and encodes literals and matches in separate, chunked blocks.
 * This version is not specification-compliant.
 */
export class LZFCodec {
    constructor() {
        this.MIN_MATCH = 3;
        this.MAX_LITERAL_CHUNK = 32;
        this.MAX_MATCH_CHUNK = 264; // Max length for a type-1 match in standard LZF
    }

    // The _findAllMatches, _mergeLiteralCommands, and _optimalParse methods
    // would be identical to the ones in LZ4Codec, so we can reuse them conceptually.
    // For a self-contained class, they are copied here.

    _findAllMatches(data, pos, minMatch) {
        const matches = [];
        const maxBack = Math.min(pos, 8192); // LZF has a smaller max offset
        const maxMatchLen = 270;

        for (let back = 1; back <= maxBack; back++) {
            let len = 0;
            while (pos + len < data.length &&
                data[pos + len] === data[pos - back + len] &&
                len < maxMatchLen) {
                len++;
            }
            if (len >= minMatch) {
                matches.push({ offset: back, length: len });
            }
        }
        return matches.sort((a, b) => b.length - a.length);
    }

    _mergeLiteralCommands(commands) {
        if (!commands || commands.length === 0) return [];
        const merged = [];
        let currentLiterals = [];

        for (const command of commands) {
            if (command.type === 'literals') {
                currentLiterals.push(...command.data);
            } else {
                if (currentLiterals.length > 0) {
                    merged.push({ type: 'literals', data: currentLiterals });
                    currentLiterals = [];
                }
                merged.push(command);
            }
        }
        if (currentLiterals.length > 0) {
            merged.push({ type: 'literals', data: currentLiterals });
        }
        return merged;
    }

    _optimalParse(data) {
        const n = data.length;
        if (n === 0) return [];

        const costs = new Array(n + 1).fill(Infinity);
        const choices = new Array(n + 1).fill(null);
        costs[0] = 0;

        for (let pos = 0; pos < n; pos++) {
            if (costs[pos] === Infinity) continue;

            // Literal
            const literalCost = costs[pos] + 9;
            if (literalCost < costs[pos + 1]) {
                costs[pos + 1] = literalCost;
                choices[pos + 1] = { type: 'literal' };
            }

            // Matches
            const matches = this._findAllMatches(data, pos, this.MIN_MATCH);
            for (const match of matches) {
                const matchEndPos = pos + match.length;
                if (matchEndPos <= n) {
                    const matchCost = costs[pos] + 24;
                    if (matchCost < costs[matchEndPos]) {
                        costs[matchEndPos] = matchCost;
                        choices[matchEndPos] = {
                            type: 'match',
                            offset: match.offset,
                            length: match.length,
                        };
                    }
                }
            }
        }

        const commands = [];
        let pos = n;
        while (pos > 0) {
            const choice = choices[pos];
            if (!choice) {
                pos--;
                continue;
            }
            if (choice.type === 'literal') {
                commands.unshift({ type: 'literals', data: [data[pos - 1]] });
                pos--;
            } else {
                commands.unshift({ type: 'match', offset: choice.offset, length: choice.length });
                pos -= choice.length;
            }
        }
        return this._mergeLiteralCommands(commands);
    }

    /**
     * Compresses the input data using an LZF-style algorithm.
     * @param {Uint8Array} data - The raw data to compress.
     * @returns {Uint8Array} - The compressed data.
     */
    compress(data) {
        const commands = this._optimalParse(data);
        const output = [];

        for (const command of commands) {
            if (command.type === 'literals') {
                let litPos = 0;
                while (litPos < command.data.length) {
                    const count = Math.min(command.data.length - litPos, this.MAX_LITERAL_CHUNK);
                    output.push(count - 1); // LZF literal control byte
                    output.push(...command.data.slice(litPos, litPos + count));
                    litPos += count;
                }
            } else if (command.type === 'match') {
                const len = command.length;
                const offset = command.offset - 1;

                if (len >= 264) { // Handle very long match (type 1)
                     output.push(7 << 5 | (offset >> 8));
                     output.push(264 - 2 - 7);
                     output.push(offset & 0xFF);
                } else if (len >= 9) { // Long match (type 1)
                    output.push(7 << 5 | (offset >> 8));
                    output.push(len - 2 - 7);
                    output.push(offset & 0xFF);
                }
                else { // Short match (type 0)
                    output.push(((len - 2) << 5) | (offset >> 8));
                    output.push(offset & 0xFF);
                }
            }
        }
        return new Uint8Array(output);
    }

    /**
     * Decompresses data compressed with the LZF-style algorithm.
     * @param {Uint8Array} data - The compressed data.
     * @returns {Uint8Array} - The original decompressed data.
     */
    decompress(data) {
        const output = [];
        let pos = 0;

        while (pos < data.length) {
            const ctrl = data[pos++];
            if (ctrl < 32) { // Literals
                const count = ctrl + 1;
                if (pos + count > data.length) break;
                output.push(...data.slice(pos, pos + count));
                pos += count;
            } else { // Match
                let len = ctrl >> 5;
                let offset = (ctrl & 0x1F) << 8;

                if (len === 7) { // Type 1 long match
                    len += data[pos++];
                }
                len += 2;
                
                offset |= data[pos++];
                offset += 1;

                const srcIndex = output.length - offset;
                for (let i = 0; i < len; i++) {
                    output.push(output[srcIndex + i]);
                }
            }
        }
        return new Uint8Array(output);
    }
}
