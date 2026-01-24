/*
  aplib.js - aPLib (apultra-compatible) codec, BitBuster-style interleaved bitstream

  Decoder based on the public-domain Kabopan aPLib description/implementation.
  Token types (bit prefixes):
    literal      -> 0
    block        -> 10
    short block  -> 110
    single byte  -> 111

  Stream rules:
    - First output byte is always a literal byte from the stream.
    - EOF is encoded as a "short block" whose parameter byte is 0 or 1 (most encoders use 0).
    - Bitstream is interleaved with payload bytes; encoder must reserve/backfill bit-bytes.
*/

const SHORT_MATCH_COST = 11; // 3 tag bits + 8 payload
const LITERAL_COST = 9; // 1 tag bit + byte
const SINGLE_MATCH_COST = 7; // 3 tag bits + 4 offset bits

const BEAM_PROFILES = {
  raw: {
    width: 10,
    branch: 8,
    heuristic: LITERAL_COST - 1,
    maxSteps: 1 << 15,
  },
  dense: {
    width: 18,
    branch: 12,
    heuristic: LITERAL_COST - 2,
    maxSteps: 1 << 16,
  },
  ultra: {
    width: 28,
    branch: 18,
    heuristic: LITERAL_COST - 3,
    maxSteps: 1 << 17,
  },
  max: {
    width: 36,
    branch: 24,
    heuristic: LITERAL_COST - 4,
    maxSteps: 1 << 17,
  },
};

const RAW_MATCH_RATIO = 0.45;
const DENSE_MATCH_RATIO = 0.62;
const ULTRA_MATCH_RATIO = 0.6;
const ULTRA_AVG_MATCH = 6;
const ULTRA_LONGEST_MATCH = 48;
const MAX_MATCH_RATIO = 0.74;
const MAX_LONGEST_MATCH = 72;
const FAST_MATCH_RATIO = 0.48;
const FAST_AVG_MATCH = 4.2;
const AGGRO_MATCH_RATIO = 0.58;
const EXTREME_MATCH_RATIO = 0.68;

/**
 * aPLib codec "Greedy++ palette": inherits aplib4's encoder/decoder but overrides
 * the match scorer so offsets 1/2 can consider multiple candidate lengths. This
 * helps repeated runs pick the cheapest block size without invoking the slow
 * DP compressor used by aplib2.
 */
export class APLibCodec {
  constructor(opts = {}) {
    this.MAX_INPUT = opts.maxInput ?? (512 * 1024);
    this.MAX_OFFSET_SEARCH = opts.maxOffsetSearch ?? 0x7fff; // for speed in JS
    this.MAX_MATCH = opts.maxMatch ?? 0xffff; // practical cap
    this.RLE_OFFSETS = opts.rleOffsets ?? [1, 2];
    this.RLE_EXTRA_MIN_LEN = opts.rleMinLen ?? 4;
    this.RLE_PARTIAL_CAP = opts.rlePartialCap ?? 12;
    this.RLE_LONG_STEP = Math.max(1, opts.rleLongStep ?? 16);
    this.RLE_GAIN_BONUS = opts.rleGainBonus ?? 4;
    this.RLE_TRIGGER_LEN = Math.max(2, opts.rleTriggerLen ?? 8);
    this.EXTRA_OFFSETS = opts.extraOffsets ?? [3, 4, 5, 6];
    this.LAZY_TOLERANCE = opts.lazyTolerance ?? 0;
    this.DOUBLE_LAZY_TOLERANCE = opts.doubleLazyTolerance ?? 2;
    this.DP_ENABLED = opts.dpEnabled ?? true;
    this.DP_MAX_SIZE = opts.dpMaxSize ?? 2048;
    this.DP_MAX_MATCHES = opts.dpMaxMatches ?? 8;
    this.DP_MAX_CHAIN = opts.dpMaxChain ?? 32;
    this.BEAM_ENABLED = opts.beamEnabled ?? true;
    this.BEAM_MAX_SIZE = opts.beamMaxSize ?? 1 << 16;
    this.BEAM_WIDTH = opts.beamWidth ?? 18;
    this.BEAM_BRANCH = opts.beamBranch ?? 12;
    this.BEAM_HEURISTIC = opts.beamHeuristic ?? (LITERAL_COST - 2);
    this.BEAM_MAX_STEPS = opts.beamMaxSteps ?? 1 << 16;
    this.ALLOW_SINGLE_ZERO = opts.allowSingleZero ?? true;
    this.REUSE_GAIN_BONUS = opts.reuseGainBonus ?? 6;
    this.REUSE_LAZY_SLACK = opts.reuseLazySlack ?? 2;
    this.REUSE_BEAM_BONUS = opts.reuseBeamBonus ?? 12;
    this.MAX_SHORT_RUN_LENGTH = opts.maxShortRunLength ?? 128;
    this.REUSE_LEN_MARGIN = opts.reuseLenMargin ?? 2;
    this.REUSE_COST_MARGIN = opts.reuseCostMargin ?? 6;
    this.FORCE_SEED_REUSE = opts.forceSeedReuse ?? true;
    this.SEED_MIN_REUSE = opts.seedMinReuse ?? 3;
    this.SEED_GAIN_BONUS = opts.seedGainBonus ?? 2;
  }

  _beginWriter(out) {
    if (!out) out = [];

    let bitPos = out.length;
    out.push(0);

    let bitData = 0;
    let bitCount = 0;

    const rotateBitByte = () => {
      out[bitPos] = bitData & 0xff;
      bitPos = out.length;
      out.push(0);
      bitData = 0;
      bitCount = 0;
    };

    const writeBit = (v) => {
      if (bitCount === 8) rotateBitByte();
      bitData = ((bitData << 1) | (v ? 1 : 0)) & 0xff;
      bitCount++;
    };

    const writeBits = (bits) => {
      for (let i = 0; i < bits.length; i++) writeBit(bits[i]);
    };

    const writeByte = (b) => {
      out.push(b & 0xff);
    };

    const writeVarNumber = (value) => {
      const v = value >>> 0;
      if (v < 2) throw new Error(`writeVarNumber expects >=2, got ${v}`);

      const msb = 31 - Math.clz32(v);
      writeBit((v >> (msb - 1)) & 1);

      for (let k = msb - 2; k >= 0; k--) {
        writeBit(1);
        writeBit((v >> k) & 1);
      }
      writeBit(0);
    };

    const flushTagByte = () => {
      if (bitCount > 0) out[bitPos] = (bitData << (8 - bitCount)) & 0xff;
      else out[bitPos] = out[bitPos] & 0xff;
    };

    const endStream = () => {
      writeBits([1, 1, 0]);
      writeByte(0);
      flushTagByte();
    };

    return { out, writeBit, writeBits, writeByte, writeVarNumber, endStream, flushTagByte };
  }

  _beginReader(bytes) {
    let pos = 0;
    let tag = 0;
    let bitsLeft = 0;

    const readByte = () => {
      if (pos >= bytes.length) throw new Error("Unexpected EOF (byte)");
      return bytes[pos++] & 0xff;
    };

    const readBit = () => {
      if (bitsLeft === 0) {
        tag = readByte();
        bitsLeft = 8;
      }
      const bit = (tag >> 7) & 1;
      tag = ((tag << 1) & 0xff);
      bitsLeft--;
      return bit;
    };

    const readFixedNumber = (numBits, init = 0) => {
      let r = init >>> 0;
      for (let i = 0; i < numBits; i++) r = (r << 1) | readBit();
      return r >>> 0;
    };

    const readVarNumber = () => {
      let r = 1;
      r = (r << 1) | readBit();
      while (readBit() === 1) {
        r = (r << 1) | readBit();
      }
      return r >>> 0;
    };

    const readSetBits = (maxBits, setValue = 1) => {
      let n = 0;
      while (n < maxBits && readBit() === setValue) n++;
      return n;
    };

    return { readByte, readBit, readFixedNumber, readVarNumber, readSetBits, get pos() { return pos; } };
  }

  _lengthDelta(offset) {
    if (offset < 0x80 || offset >= 0x7d00) return 2;
    if (offset >= 0x500) return 1;
    return 0;
  }

  decompress(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length < 1) return new Uint8Array(0);

    const R = this._beginReader(bytes);
    const out = [];

    out.push(R.readByte());

    let pair = true;
    let lastOffset = 0;

    const backCopy = (offset, length) => {
      if (offset <= 0 || offset > out.length) throw new Error(`Invalid offset ${offset} at outLen=${out.length}`);
      for (let i = 0; i < length; i++) out.push(out[out.length - offset]);
    };

    while (true) {
      const kind = R.readSetBits(3);
      if (kind === 0) {
        out.push(R.readByte());
        pair = true;
        continue;
      }

      if (kind === 1) {
        let b = (R.readVarNumber() - 2) | 0;

        let offset, length;
        if (b === 0 && pair) {
          offset = lastOffset;
          length = R.readVarNumber() | 0;
        } else {
          if (pair) b -= 1;
          offset = (b * 256 + R.readByte()) | 0;

          length = (R.readVarNumber() + this._lengthDelta(offset)) | 0;
          lastOffset = offset;
        }

        backCopy(offset, length);
        pair = false;
        continue;
      }

      if (kind === 2) {
        const b = R.readByte();
        if (b <= 1) break;
        const length = 2 + (b & 1);
        const offset = (b >> 1) & 0x7f;
        backCopy(offset, length);
        lastOffset = offset;
        pair = false;
        continue;
      }

      const offset = R.readFixedNumber(4) | 0;
      if (offset) {
        backCopy(offset, 1);
        pair = true;
      } else {
        out.push(0);
        pair = true;
      }
    }

    return Uint8Array.from(out);
  }

  compress(input) {
    if (!(input instanceof Uint8Array)) input = new Uint8Array(input);
    const n = input.length >>> 0;

    if (n === 0) return new Uint8Array(0);
    if (n > this.MAX_INPUT) throw new Error(`Input too large (${n} > ${this.MAX_INPUT})`);

    if (this.DP_ENABLED && n <= this.DP_MAX_SIZE) {
      const dpStream = this._tryDPCompression(input);
      if (dpStream) return dpStream;
    }

    const originalBeamProfile = this._captureBeamProfile();
    let finalStream;

    try {
      const matchScores = this._scoreOffsets(input);
      const greedyMatchCache = new Map();
      const greedyLenCache = new Map();
      const greedyStats = this._createCompressionStats();
      const greedyOut = this._compressWithEvaluator(
        input,
        (arr, pos, pair, lastOffset) =>
          this._evaluateMatchGreedy(
            arr,
            pos,
            pair,
            lastOffset,
            null,
            greedyMatchCache,
            greedyLenCache,
            matchScores
          ),
        greedyStats
      );

      const statsInfo = this._analyzeStats(greedyStats);
      const strategy = this._decideStrategy(statsInfo, n);
      const beamProfile = this._selectAdaptiveProfile(greedyStats, n);
      let bestStream = greedyOut;

      const rleInfo = strategy.skipPalette ? null : this._needsPalettePass(input);
      if (rleInfo) {
        const paletteMatchCache = new Map();
        const paletteLenCache = new Map();
        const paletteOut = this._compressWithEvaluator(
          input,
          (arr, pos, pair, lastOffset) =>
            this._evaluateMatchPalette(
              arr,
              pos,
              pair,
              lastOffset,
              null,
              paletteMatchCache,
              paletteLenCache,
              matchScores
            )
        );

        if (paletteOut.length <= greedyOut.length) {
          bestStream = paletteOut;
        } else {
          const biasedMatchCache = new Map();
          const biasedLenCache = new Map();
          const biasedOut = this._compressWithEvaluator(
            input,
            (arr, pos, pair, lastOffset) =>
              this._evaluateMatchGreedy(
                arr,
                pos,
                pair,
                lastOffset,
                rleInfo.offset,
                biasedMatchCache,
                biasedLenCache,
                matchScores
              )
          );
          if (biasedOut.length < greedyOut.length) {
            const merged = this._mergeStreams(greedyOut, biasedOut, paletteOut.length, biasedOut.length);
            if (merged.length < bestStream.length) {
              bestStream = merged;
            }
          }
        }
      }

      if (!strategy.skipBeam) {
        const profileQueue = this._buildBeamProfileQueue(beamProfile, statsInfo, greedyStats, strategy);
        let remaining = strategy.maxProfiles ?? profileQueue.length;
        for (const profileName of profileQueue) {
          if (remaining !== undefined && remaining <= 0) break;
          const candidate = this._beamSearchCompress(input, matchScores, bestStream.length, profileName);
          if (candidate && candidate.length < bestStream.length) {
            bestStream = candidate;
          }
          if (remaining !== undefined) remaining--;
        }
      }

      finalStream = bestStream;
    } finally {
      this._restoreBeamProfile(originalBeamProfile);
    }

    return finalStream;
  }

  _compressWithEvaluator(input, evaluator, stats = null) {
    if (!(input instanceof Uint8Array)) input = new Uint8Array(input);
    const n = input.length >>> 0;
    if (n === 0) return new Uint8Array(0);

    const out = [input[0]];
    const W = this._beginWriter(out);

    let pair = true;
    let lastOffset = 0;
    const pendingMatches = [];
    const lenCache = new Map();
    const recordLiteral = stats
      ? (len = 1) => {
          stats.literalOps += 1;
          stats.literalBytes += len;
        }
      : null;
    const recordMatch = stats
      ? (len = 1) => {
          stats.matchOps += 1;
          stats.matchBytes += len;
          if (len > stats.longestMatch) stats.longestMatch = len;
        }
      : null;

    for (let i = 1; i < n;) {
      let fromQueue = false;
      let match;
      if (pendingMatches.length) {
        match = pendingMatches.shift();
        fromQueue = true;
      } else {
        match = evaluator(input, i, pair, lastOffset);
      }

      if (!fromQueue && match && match.kind === "block") {
        const split = this._splitBlockMatch(match, pair);
        if (split) {
          match = split.first;
          pendingMatches.unshift(split.second);
        }
      }

      let forcedSeedTaken = false;
      const forcedSeed = !pair ? this._forceSeedReuseCandidate(input, i, lastOffset, lenCache) : null;
      if (forcedSeed) {
        match = forcedSeed;
        forcedSeedTaken = true;
      }

      let useMatch = !!match;
      if (match && !fromQueue) {
          const lazySlack = (match.kind === "reuse" ? this.REUSE_LAZY_SLACK : 0);
          const next = (i + 1 < n) ? evaluator(input, i + 1, true, lastOffset) : null;
          if (next && (1 + next.length) >= match.length) {
            const skipCost = LITERAL_COST + next.cost;
          if (skipCost + this.LAZY_TOLERANCE + lazySlack < match.cost) useMatch = false;
        }

        if (useMatch) {
          const next2 = (i + 2 < n) ? evaluator(input, i + 2, true, lastOffset) : null;
          if (next2 && (2 + next2.length) >= match.length) {
          const skip2 = 2 * LITERAL_COST + next2.cost;
          if (!forcedSeedTaken && skip2 + this.DOUBLE_LAZY_TOLERANCE + lazySlack < match.cost) {
            useMatch = false;
          }
        }
        }
      }

      if (!useMatch && !forcedSeedTaken) {
        const singleOff = this._singleOffset(input, i);
        const canSingleZero = this.ALLOW_SINGLE_ZERO && !singleOff && input[i] === 0;
        if (singleOff || canSingleZero) {
          const singOffset = singleOff || 0;
          W.writeBits([1, 1, 1]);
          W.writeBit((singOffset >> 3) & 1);
          W.writeBit((singOffset >> 2) & 1);
          W.writeBit((singOffset >> 1) & 1);
          W.writeBit(singOffset & 1);
          if (recordMatch) recordMatch(1);
          } else {
            W.writeBit(0);
            W.writeByte(input[i]);
            if (recordLiteral) recordLiteral(1);
          }
        pair = true;
        i++;
        continue;
      }

      const converted = this._convertBlockToShortRun(match, pair);
      if (converted) match = converted;

      switch (match.kind) {
        case "single":
          W.writeBits([1, 1, 1]);
          W.writeBit((match.offset >> 3) & 1);
          W.writeBit((match.offset >> 2) & 1);
          W.writeBit((match.offset >> 1) & 1);
          W.writeBit(match.offset & 1);
          pair = true;
          if (recordMatch) recordMatch(1);
          i++;
          break;
        case "short":
          W.writeBits([1, 1, 0]);
          W.writeByte(((match.offset & 0x7f) << 1) | (match.length - 2));
          lastOffset = match.offset;
          pair = false;
          if (recordMatch) recordMatch(match.length);
          i += match.length;
          break;
        case "shortRun": {
          let remaining = match.length;
          while (remaining > 0) {
            let chunk;
            if (remaining === 4) {
              chunk = 2;
            } else if (remaining >= 3) {
              chunk = 3;
            } else {
              chunk = 2;
            }
            W.writeBits([1, 1, 0]);
            W.writeByte(((match.offset & 0x7f) << 1) | (chunk - 2));
            remaining -= chunk;
          }
          lastOffset = match.offset;
          pair = false;
          if (recordMatch) recordMatch(match.length);
          i += match.length;
          break;
        }
        case "reuse":
          W.writeBits([1, 0]);
          W.writeVarNumber(2);
          W.writeVarNumber(Math.max(match.length, 2));
          pair = false;
          if (recordMatch) recordMatch(match.length);
          i += match.length;
          break;
        case "seedLiteral": {
          const reuseLen = match.reuseLength ?? Math.max(match.length - 1, 2);
          W.writeBit(0);
          W.writeByte(input[i]);
          pair = true;
          if (recordLiteral) recordLiteral(1);
          i += 1;
          W.writeBits([1, 0]);
          W.writeVarNumber(2);
          W.writeVarNumber(reuseLen);
          pair = false;
          if (recordMatch) recordMatch(reuseLen);
          i += reuseLen;
          break;
        }
        case "seedSingle": {
          const reuseLen = match.reuseLength ?? Math.max(match.length - 1, 2);
          const seedOffset = match.seedOffset ?? match.offset;
          W.writeBits([1, 1, 1]);
          W.writeBit((seedOffset >> 3) & 1);
          W.writeBit((seedOffset >> 2) & 1);
          W.writeBit((seedOffset >> 1) & 1);
          W.writeBit(seedOffset & 1);
          pair = true;
          if (recordMatch) recordMatch(1);
          i += 1;
          W.writeBits([1, 0]);
          W.writeVarNumber(2);
          W.writeVarNumber(reuseLen);
          pair = false;
          if (recordMatch) recordMatch(reuseLen);
          i += reuseLen;
          break;
        }
        case "block": {
          W.writeBits([1, 0]);
          const offset = match.offset;
          const high = (offset >>> 8) & 0xffff;
          const low = offset & 0xff;
          const varOffset = (pair ? (high + 3) : (high + 2)) >>> 0;
          W.writeVarNumber(varOffset);
          W.writeByte(low);
          const delta = this._lengthDelta(offset);
          const storedLen = (match.length - delta) | 0;
          W.writeVarNumber(storedLen);
          lastOffset = offset;
          pair = false;
          if (recordMatch) recordMatch(match.length);
          i += match.length;
          break;
        }
        default:
          throw new Error(`Unknown match kind ${match.kind}`);
      }
    }

    W.endStream();
    return new Uint8Array(W.out);
  }

  _createCompressionStats() {
    return {
      literalBytes: 0,
      matchBytes: 0,
      literalOps: 0,
      matchOps: 0,
      longestMatch: 0,
    };
  }

  _analyzeStats(stats) {
    if (!stats) {
      return {
        matchRatio: 0,
        avgMatchLen: 0,
        longestMatch: 0,
        preferDense: false,
        preferRaw: true,
      };
    }
    const totalBytes = stats.literalBytes + stats.matchBytes;
    const matchRatio = totalBytes ? stats.matchBytes / totalBytes : 0;
    const avgMatchLen = stats.matchOps ? stats.matchBytes / stats.matchOps : 0;
    return {
      matchRatio,
      avgMatchLen,
      longestMatch: stats.longestMatch || 0,
      preferDense: matchRatio >= 0.48 || avgMatchLen >= 4.5,
      preferRaw: matchRatio < 0.4 || avgMatchLen < 4,
    };
  }

  _decideStrategy(statsInfo, totalLength) {
    if (!statsInfo) {
      return { tier: "balanced", maxProfiles: 2, skipPalette: false, skipBeam: false };
    }
    const { matchRatio, avgMatchLen } = statsInfo;
    if (matchRatio < FAST_MATCH_RATIO && avgMatchLen < FAST_AVG_MATCH) {
      return { tier: "fast", maxProfiles: 0, skipPalette: true, skipBeam: true };
    }
    if (matchRatio > EXTREME_MATCH_RATIO) {
      return { tier: "extreme", maxProfiles: 4, skipPalette: false, skipBeam: false };
    }
    if (matchRatio > AGGRO_MATCH_RATIO || avgMatchLen >= 5.5) {
      return { tier: "aggressive", maxProfiles: totalLength > 20000 ? 2 : 3, skipPalette: false, skipBeam: false };
    }
    return {
      tier: "balanced",
      maxProfiles: totalLength > 20000 ? 1 : 2,
      skipPalette: matchRatio < 0.5 && totalLength > 8192,
      skipBeam: false,
    };
  }

  _buildBeamProfileQueue(selectedProfile, statsInfo, rawStats, strategy) {
    if (strategy?.skipBeam) return [];
    const queue = [];
    const seen = new Set();
    const pushProfile = (name) => {
      const key = name ?? "__default__";
      if (seen.has(key)) return;
      if (name && !BEAM_PROFILES[name]) return;
      seen.add(key);
      queue.push(name);
    };

    pushProfile(selectedProfile ?? null);

    if (statsInfo?.preferDense) pushProfile("dense");
    if (statsInfo?.preferRaw) pushProfile("raw");
    if (strategy?.tier !== "fast" && this._shouldUseUltraBeam(rawStats)) pushProfile("ultra");
    if (strategy?.tier === "extreme" && this._shouldUseMaxBeam(rawStats)) pushProfile("max");

    if (!queue.length) pushProfile(null);
    return queue;
  }

  _selectAdaptiveProfile(stats, totalLength) {
    if (!stats) return null;
    const totalBytes = stats.literalBytes + stats.matchBytes;
    if (!totalBytes) return null;
    const matchRatio = stats.matchBytes / totalBytes;
    const avgMatchLen = stats.matchOps ? stats.matchBytes / stats.matchOps : 0;
    if (totalLength <= 256 && matchRatio < 0.5) return "raw";
    if (matchRatio < RAW_MATCH_RATIO || avgMatchLen < 4) return "raw";
    if (matchRatio > DENSE_MATCH_RATIO || avgMatchLen >= 6 || stats.longestMatch >= 32) return "dense";
    return matchRatio < 0.52 ? "raw" : "dense";
  }

  _shouldUseUltraBeam(stats) {
    if (!stats) return false;
    const totalBytes = stats.literalBytes + stats.matchBytes;
    if (!totalBytes) return false;
    const matchRatio = stats.matchBytes / totalBytes;
    const avgMatchLen = stats.matchOps ? stats.matchBytes / stats.matchOps : 0;
    if (matchRatio >= ULTRA_MATCH_RATIO) return true;
    if (stats.longestMatch >= ULTRA_LONGEST_MATCH) return true;
    if (avgMatchLen >= ULTRA_AVG_MATCH && stats.longestMatch >= ULTRA_LONGEST_MATCH / 2) return true;
    if (matchRatio >= 0.5 && avgMatchLen >= 5.5 && stats.longestMatch >= 40) return true;
    return false;
  }

  _shouldUseMaxBeam(stats) {
    if (!stats) return false;
    const totalBytes = stats.literalBytes + stats.matchBytes;
    if (!totalBytes) return false;
    const matchRatio = stats.matchBytes / totalBytes;
    if (matchRatio >= MAX_MATCH_RATIO && stats.longestMatch >= 56) return true;
    if (stats.longestMatch >= MAX_LONGEST_MATCH) return true;
    return false;
  }

  _captureBeamProfile() {
    return {
      width: this.BEAM_WIDTH,
      branch: this.BEAM_BRANCH,
      heuristic: this.BEAM_HEURISTIC,
      maxSteps: this.BEAM_MAX_STEPS,
    };
  }

  _restoreBeamProfile(snapshot) {
    if (!snapshot) return;
    this.BEAM_WIDTH = snapshot.width;
    this.BEAM_BRANCH = snapshot.branch;
    this.BEAM_HEURISTIC = snapshot.heuristic;
    this.BEAM_MAX_STEPS = snapshot.maxSteps;
  }

  _applyBeamProfile(profileName) {
    if (!profileName) return;
    const profile = BEAM_PROFILES[profileName];
    if (!profile) return;
    this.BEAM_WIDTH = profile.width;
    this.BEAM_BRANCH = profile.branch;
    this.BEAM_HEURISTIC = profile.heuristic;
    this.BEAM_MAX_STEPS = profile.maxSteps;
  }

  _beamSearchCompress(input, matchScores, currentBestLength = Infinity, profileName = null) {
    const originalProfile = this._captureBeamProfile();
    try {
      this._applyBeamProfile(profileName);
      if (!this.BEAM_ENABLED) return null;
      if (!(input instanceof Uint8Array)) input = new Uint8Array(input);
      const n = input.length >>> 0;
      if (n <= 1 || n > this.BEAM_MAX_SIZE) return null;

      const matchCache = new Map();
      const lenCache = new Map();
      const ops = this._beamSearchPlan(input, matchScores, matchCache, lenCache);
      if (!ops || !ops.length) return null;
      const stream = this._emitPlanOps(input, ops);
      if (!stream) return null;
      if (stream.length >= currentBestLength) return null;
      return stream;
    } finally {
      this._restoreBeamProfile(originalProfile);
    }
  }

  _beamSearchPlan(input, matchScores, matchCache, lenCache) {
    const n = input.length >>> 0;
    if (n <= 1) return null;
    const width = Math.max(1, this.BEAM_WIDTH | 0);
    const branchLimit = Math.max(1, this.BEAM_BRANCH | 0);
    const heuristicWeight = Math.max(1, this.BEAM_HEURISTIC | 0);
    const maxSteps = Math.max(n * 2, this.BEAM_MAX_STEPS | 0);

    const initial = {
      pos: 1,
      pair: true,
      lastOffset: 0,
      cost: 0,
      heuristic: (n - 1) * heuristicWeight,
      prev: null,
      op: null,
    };

    let frontier = [initial];
    let bestFinal = null;

    for (let steps = 0; steps < maxSteps && frontier.length; steps++) {
      const nextMap = new Map();
      let expanded = false;

      for (const state of frontier) {
        if (state.pos >= n) {
          if (!bestFinal || state.cost < bestFinal.cost) bestFinal = state;
          continue;
        }
        expanded = true;

        const { candidates, singleOffset } = this._collectCandidates(
          input,
          state.pos,
          state.pair,
          state.lastOffset,
          matchCache,
          lenCache,
          matchScores
        );

        const options = [];
        options.push({ kind: "literal", length: 1, cost: LITERAL_COST });
        if (singleOffset !== null && singleOffset !== undefined) {
          options.push({
            kind: "single",
            length: 1,
            offset: singleOffset,
            cost: SINGLE_MATCH_COST,
          });
        }
        const matchOptions = branchLimit > 0 ? candidates.slice(0, branchLimit) : candidates;
        options.push(...matchOptions);

        for (const cand of options) {
          const nextState = this._advanceBeamState(state, cand, n, heuristicWeight);
          if (!nextState) continue;
          const key = `${nextState.pos}|${nextState.pair ? 1 : 0}|${nextState.lastOffset}`;
          const existing = nextMap.get(key);
          if (!existing || nextState.heuristic < existing.heuristic) {
            nextMap.set(key, nextState);
          }
        }
      }

      if (!expanded) break;
      const nextStates = Array.from(nextMap.values());
      if (!nextStates.length) break;
      nextStates.sort((a, b) => a.heuristic - b.heuristic || a.cost - b.cost);
      frontier = nextStates.slice(0, width);
    }

    if (!bestFinal) {
      bestFinal = frontier.find((state) => state.pos >= n) || null;
    }
    if (!bestFinal || bestFinal.pos < n) return null;

    const ops = [];
    for (let node = bestFinal; node && node.op; node = node.prev) {
      ops.push(node.op);
    }
    ops.reverse();
    return ops;
  }

  _advanceBeamState(state, match, totalLength, heuristicWeight) {
    const length = Math.max(1, match.length | 0);
    const nextPos = state.pos + length;
    if (nextPos > totalLength) return null;
    const op = this._clonePlanOp(match);

    let pair = state.pair;
    let lastOffset = state.lastOffset;
    switch (match.kind) {
      case "literal":
        pair = true;
        break;
      case "single":
        pair = true;
        break;
      case "short":
        pair = false;
        lastOffset = match.offset;
        break;
      case "shortRun":
        pair = false;
        lastOffset = match.offset;
        break;
      case "reuse":
        pair = false;
        break;
      case "block":
        pair = false;
        lastOffset = match.offset;
        break;
      case "seedLiteral":
      case "seedSingle":
        pair = false;
        break;
      default:
        return null;
    }

    const nextCost = state.cost + match.cost;
    const reuseBoost = (match.kind === "reuse" ? this.REUSE_BEAM_BONUS : 0);
    const heuristic = nextCost + (totalLength - nextPos) * heuristicWeight - reuseBoost;
    return {
      pos: nextPos,
      pair,
      lastOffset,
      cost: nextCost,
      heuristic,
      prev: state,
      op,
    };
  }

  _clonePlanOp(match) {
    const op = { type: match.kind };
    if ("offset" in match) op.offset = match.offset;
    if ("length" in match) op.length = match.length;
    if ("reuseLength" in match) op.reuseLength = match.reuseLength;
    if ("seedOffset" in match) op.seedOffset = match.seedOffset;
    return op;
  }

  _emitPlanOps(input, ops) {
    if (!(input instanceof Uint8Array)) input = new Uint8Array(input);
    const n = input.length >>> 0;
    if (n === 0) return new Uint8Array(0);
    const out = [input[0]];
    const W = this._beginWriter(out);
    let pair = true;
    let lastOffset = 0;
    let i = 1;

    for (const raw of ops) {
      if (i >= n) break;
      const kind = raw.type ?? raw.kind;
      switch (kind) {
        case "literal":
          W.writeBit(0);
          W.writeByte(input[i]);
          pair = true;
          i += 1;
          break;
        case "single": {
          let off = raw.offset;
          if (off === undefined || off === null) {
            off = this._singleOffset(input, i);
            if (!off && this.ALLOW_SINGLE_ZERO && input[i] === 0) off = 0;
          }
          if (off === undefined || off === null) return null;
          if (off < 0 || off > 15) return null;
          if (i >= n) return null;
          W.writeBits([1, 1, 1]);
          W.writeBit((off >> 3) & 1);
          W.writeBit((off >> 2) & 1);
          W.writeBit((off >> 1) & 1);
          W.writeBit(off & 1);
          pair = true;
          i += 1;
          break;
        }
        case "short": {
          if (!raw.offset || raw.length < 2 || raw.offset > 127) return null;
          if (i + raw.length > n) return null;
          W.writeBits([1, 1, 0]);
          W.writeByte(((raw.offset & 0x7f) << 1) | (raw.length - 2));
          lastOffset = raw.offset;
          pair = false;
          i += raw.length;
          break;
        }
        case "shortRun": {
          if (!raw.offset || raw.length < 2 || raw.offset > 127) return null;
          if (i + raw.length > n) return null;
          let remaining = raw.length;
          while (remaining > 0) {
            let chunk;
            if (remaining === 4) chunk = 2;
            else if (remaining >= 3) chunk = 3;
            else chunk = 2;
            W.writeBits([1, 1, 0]);
            W.writeByte(((raw.offset & 0x7f) << 1) | (chunk - 2));
            remaining -= chunk;
          }
          lastOffset = raw.offset;
          pair = false;
          i += raw.length;
          break;
        }
        case "reuse": {
          const reuseLen = Math.max(raw.length | 0, 2);
          if (i + reuseLen > n) return null;
          W.writeBits([1, 0]);
          W.writeVarNumber(2);
          W.writeVarNumber(reuseLen);
          pair = false;
          i += reuseLen;
          break;
        }
        case "seedLiteral": {
          const reuseLen = raw.reuseLength ?? Math.max((raw.length ?? 2) - 1, 2);
          if (i >= n) return null;
          W.writeBit(0);
          W.writeByte(input[i]);
          pair = true;
          i += 1;
          if (i + reuseLen > n) return null;
          W.writeBits([1, 0]);
          W.writeVarNumber(2);
          W.writeVarNumber(reuseLen);
          pair = false;
          i += reuseLen;
          break;
        }
        case "seedSingle": {
          const reuseLen = raw.reuseLength ?? Math.max((raw.length ?? 2) - 1, 2);
          if (i >= n) return null;
          let seedOffset = raw.seedOffset ?? raw.offset;
          if (seedOffset === undefined || seedOffset === null) {
            seedOffset = this._singleOffset(input, i);
            if (!seedOffset && this.ALLOW_SINGLE_ZERO && input[i] === 0) seedOffset = 0;
          }
          if (seedOffset === 0 || seedOffset < 0 || seedOffset > 15) return null;
          W.writeBits([1, 1, 1]);
          W.writeBit((seedOffset >> 3) & 1);
          W.writeBit((seedOffset >> 2) & 1);
          W.writeBit((seedOffset >> 1) & 1);
          W.writeBit(seedOffset & 1);
          pair = true;
          i += 1;
          if (i + reuseLen > n) return null;
          W.writeBits([1, 0]);
          W.writeVarNumber(2);
          W.writeVarNumber(reuseLen);
          pair = false;
          i += reuseLen;
          break;
        }
        case "block": {
          if (!raw.offset || raw.length < 2) return null;
          if (i + raw.length > n) return null;
          W.writeBits([1, 0]);
          const offset = raw.offset;
          const high = (offset >>> 8) & 0xffff;
          const low = offset & 0xff;
          const varOffset = (pair ? (high + 3) : (high + 2)) >>> 0;
          W.writeVarNumber(varOffset);
          W.writeByte(low);
          const delta = this._lengthDelta(offset);
          const storedLen = (raw.length - delta) | 0;
          if (storedLen < 2) return null;
          W.writeVarNumber(storedLen);
          lastOffset = offset;
          pair = false;
          i += raw.length;
          break;
        }
        default:
          return null;
      }
    }

    if (i !== n) return null;
    W.endStream();
    return new Uint8Array(W.out);
  }

  /**
   * Override aplib4's evaluator to inject additional candidates for offsets 1/2
   * and to bias toward longer runs when they beat literals by a few bits.
   */
  _evaluateMatch(input, pos, pair, lastOffset, matchCache = null, lenCache = null, matchScores = null) {
    return this._evaluateMatchPalette(input, pos, pair, lastOffset, matchCache, lenCache, matchScores);
  }

  _evaluateMatchPalette(input, pos, pair, lastOffset, matchCache = null, lenCache = null, matchScores = null) {
    const { candidates, singleOffset } = this._collectCandidates(
      input,
      pos,
      pair,
      lastOffset,
      matchCache,
      lenCache,
      matchScores
    );
    const forcedSeed = !pair ? this._forceSeedReuseCandidate(input, pos, lastOffset, lenCache) : null;
    if (forcedSeed) candidates.unshift(forcedSeed);
    if (!candidates.length) {
      return singleOffset !== null && singleOffset !== undefined
        ? { kind: "single", offset: singleOffset, length: 1, cost: SINGLE_MATCH_COST }
        : null;
    }
    let best = candidates[0];
    const reuseCandidate = candidates.find((c) => c.kind === "reuse");
    if (reuseCandidate && best.kind !== "reuse") {
      if (
        reuseCandidate.length + this.REUSE_LEN_MARGIN >= best.length &&
        reuseCandidate.cost <= best.cost + this.REUSE_COST_MARGIN
      ) {
        best = reuseCandidate;
      }
    }
    if (best.length * LITERAL_COST <= best.cost && best.kind !== "single") {
      return singleOffset !== null && singleOffset !== undefined
        ? { kind: "single", offset: singleOffset, length: 1, cost: SINGLE_MATCH_COST }
        : null;
    }
    return { ...best };
  }

  _collectCandidates(input, pos, pair, lastOffset, matchCache = null, lenCache = null, matchScores = null) {
    const n = input.length >>> 0;
    const offsetMap = new Map();
    const base = this._getCachedMatch(input, pos, matchCache);
    if (base.length >= 2) offsetMap.set(base.offset, Math.min(base.length, n - pos));

    for (const off of this.RLE_OFFSETS) {
      if (off <= 0 || off > pos || offsetMap.has(off)) continue;
      const len = this._matchLengthAtOffset(input, pos, off, lenCache);
      if (len >= this.RLE_EXTRA_MIN_LEN) offsetMap.set(off, len);
    }
    for (const off of this.EXTRA_OFFSETS) {
      if (off <= 0 || off > pos || offsetMap.has(off)) continue;
      const len = this._matchLengthAtOffset(input, pos, off, lenCache);
      if (len >= 3) offsetMap.set(off, len);
    }

    let singleOffset = this._singleOffset(input, pos);
    if (!singleOffset) {
      if (this.ALLOW_SINGLE_ZERO && input[pos] === 0) {
        singleOffset = 0;
      } else {
        singleOffset = null;
      }
    }

    if (!offsetMap.size) {
      return { candidates: [], singleOffset };
    }

    const candidates = [];
    for (const [offset, rawLen] of offsetMap.entries()) {
      const maxLen = Math.min(rawLen, n - pos, this.MAX_MATCH);
      const palette = this._lengthPalette(maxLen);
      for (const len of palette) {
        if (len < 2 || len > maxLen) continue;
        if (offset <= 127 && len <= 3) {
          candidates.push({ kind: "short", offset, length: len, cost: SHORT_MATCH_COST });
        }
        if (offset <= 127 && len >= 4) {
          candidates.push({
            kind: "shortRun",
            offset,
            length: len,
            cost: this._shortRunCost(len),
          });
        }
        const canReuse = pair && offset === lastOffset;
        if (canReuse && len >= 2) {
          candidates.push({
            kind: "reuse",
            offset,
            length: len,
            cost: 2 + this._varBits(2) + this._varBits(len),
          });
        }
        const delta = this._lengthDelta(offset);
        if (len >= delta + 2) {
          const storedLen = len - delta;
          if (storedLen >= 2) {
            const high = offset >>> 8;
            const varOffset = (pair ? (high + 3) : (high + 2)) >>> 0;
            const cost = 2 + this._varBits(varOffset) + 8 + this._varBits(storedLen);
            candidates.push({ kind: "block", offset, length: len, cost });
          }
        }
      }
      const allowSeed =
        !pair &&
        offset === lastOffset &&
        maxLen >= Math.max(3, this.SEED_MIN_REUSE);
      if (allowSeed) {
        const reusePalette = this._lengthPalette(maxLen - 1);
        for (const reuseLen of reusePalette) {
          if (reuseLen < 2) continue;
          const reuseCost = 2 + this._varBits(2) + this._varBits(reuseLen);
          candidates.push({
            kind: "seedLiteral",
            offset,
            length: reuseLen + 1,
            reuseLength: reuseLen,
            cost: LITERAL_COST + reuseCost - this.SEED_GAIN_BONUS,
          });
          if (offset <= 15 || (this.ALLOW_SINGLE_ZERO && offset === 0)) {
            candidates.push({
              kind: "seedSingle",
              offset,
              length: reuseLen + 1,
              reuseLength: reuseLen,
              cost: SINGLE_MATCH_COST + reuseCost - this.SEED_GAIN_BONUS,
            });
          }
        }
      }
    }

    if (pair && lastOffset > 0) {
      const reuseLen = this._matchLengthAtOffset(input, pos, lastOffset, lenCache);
      if (reuseLen >= 2) {
        candidates.push({
          kind: "reuse",
          offset: lastOffset,
          length: reuseLen,
          cost: 2 + this._varBits(2) + this._varBits(reuseLen),
        });
      }
    }

    if (!candidates.length) {
      return { candidates: [], singleOffset };
    }

    const nearestBonus = (offset) => {
      if (!matchScores) return 0;
      return matchScores[offset] ?? 0;
    };

    candidates.sort((a, b) => {
      const bonusA =
        (this._isRLEOffset(a.offset) ? this.RLE_GAIN_BONUS : 0) +
        nearestBonus(a.offset) +
        (pair && lastOffset && a.offset === lastOffset ? this.REUSE_GAIN_BONUS : 0);
      const bonusB =
        (this._isRLEOffset(b.offset) ? this.RLE_GAIN_BONUS : 0) +
        nearestBonus(b.offset) +
        (pair && lastOffset && b.offset === lastOffset ? this.REUSE_GAIN_BONUS : 0);
      const gainA = a.length * LITERAL_COST - a.cost + bonusA;
      const gainB = b.length * LITERAL_COST - b.cost + bonusB;
      if (gainA !== gainB) return gainB - gainA;
      if (a.cost !== b.cost) return a.cost - b.cost;
      return b.length - a.length;
    });

    return { candidates, singleOffset };
  }

  _forceSeedReuseCandidate(input, pos, lastOffset, lenCache) {
    if (!this.FORCE_SEED_REUSE || !lastOffset) return null;
    const reuseLen = this._matchLengthAtOffset(input, pos, lastOffset, lenCache);
    if (reuseLen < this.SEED_MIN_REUSE) return null;
    const reuseCost = 2 + this._varBits(2) + this._varBits(reuseLen);
    const literalCost = LITERAL_COST + reuseCost - this.SEED_GAIN_BONUS;
    const singleCost = SINGLE_MATCH_COST + reuseCost - this.SEED_GAIN_BONUS;
    if (literalCost <= singleCost || lastOffset > 15) {
      return {
        kind: "seedLiteral",
        offset: lastOffset,
        length: reuseLen + 1,
        reuseLength: reuseLen,
        cost: literalCost,
        force: true,
      };
    }
    return {
      kind: "seedSingle",
      offset: lastOffset,
      length: reuseLen + 1,
      reuseLength: reuseLen,
      cost: singleCost,
      force: true,
    };
  }

  _evaluateMatchGreedy(
    input,
    pos,
    pair,
    lastOffset,
    capOffset = null,
    matchCache = null,
    lenCache = null,
    matchScores = null
  ) {
    const { length: bestLen, offset: bestOffset } = this._getCachedMatch(input, pos, matchCache);
    if (bestLen < 2) {
      const singleOff = this._singleOffset(input, pos);
      if (singleOff) {
        return { kind: "single", offset: singleOff, length: 1, cost: SHORT_MATCH_COST };
      }
      if (this.ALLOW_SINGLE_ZERO && input[pos] === 0) {
        return { kind: "single", offset: 0, length: 1, cost: SINGLE_MATCH_COST };
      }
      return null;
    }

    const candidates = [];

    const effectiveOffset = capOffset ? Math.min(bestOffset, capOffset) : bestOffset;

    if (effectiveOffset <= 127) {
      const shortLen = Math.min(bestLen, 3);
      if (shortLen >= 2) {
        candidates.push({
          kind: "short",
          offset: bestOffset,
          length: shortLen,
          cost: SHORT_MATCH_COST,
        });
      }
      if (bestLen >= 4) {
        candidates.push({
          kind: "shortRun",
          offset: effectiveOffset,
          length: bestLen,
          cost: this._shortRunCost(bestLen),
        });
      }
    }

    const canReuse = pair && effectiveOffset === lastOffset;
    if (canReuse) {
      candidates.push({
        kind: "reuse",
        offset: bestOffset,
        length: bestLen,
        cost: 2 + this._varBits(2) + this._varBits(bestLen),
      });
    } else if (pair && lastOffset > 0) {
      const reuseLen = this._matchLengthAtOffset(input, pos, lastOffset, lenCache);
      if (reuseLen >= 2) {
        candidates.push({
          kind: "reuse",
          offset: lastOffset,
          length: reuseLen,
          cost: 2 + this._varBits(2) + this._varBits(reuseLen),
        });
      }
    }

    const delta = this._lengthDelta(effectiveOffset);
    if (bestLen >= delta + 2) {
      const storedLen = bestLen - delta;
      if (storedLen >= 2) {
        const high = bestOffset >>> 8;
        const varOffset = (pair ? (high + 3) : (high + 2)) >>> 0;
        const cost = 2 + this._varBits(varOffset) + 8 + this._varBits(storedLen);
        candidates.push({
          kind: "block",
          offset: bestOffset,
          length: bestLen,
          cost,
        });
      }
    }

    if (!candidates.length) {
      const singleOff = this._singleOffset(input, pos);
      if (singleOff) return { kind: "single", offset: singleOff, length: 1, cost: SHORT_MATCH_COST };
      if (this.ALLOW_SINGLE_ZERO && input[pos] === 0) {
        return { kind: "single", offset: 0, length: 1, cost: SINGLE_MATCH_COST };
      }
      return null;
    }

    const nearestBonus = (offset) => {
      if (!matchScores) return 0;
      return matchScores[offset] ?? 0;
    };

    candidates.sort((a, b) => {
      const gainA = a.length * LITERAL_COST - a.cost + nearestBonus(a.offset);
      const gainB = b.length * LITERAL_COST - b.cost + nearestBonus(b.offset);
      if (gainA !== gainB) return gainB - gainA;
      return a.cost - b.cost;
    });
    let best = candidates[0];
    const reuseCandidate = candidates.find((c) => c.kind === "reuse");
    if (reuseCandidate && best.kind !== "reuse") {
      if (
        reuseCandidate.length + this.REUSE_LEN_MARGIN >= best.length &&
        reuseCandidate.cost <= best.cost + this.REUSE_COST_MARGIN
      ) {
        best = reuseCandidate;
      }
    }
    return best;
  }

  _lengthPalette(maxLen) {
    const limit = Math.min(this.MAX_MATCH, Math.max(0, maxLen | 0));
    if (limit < 2) return [];
    const palette = new Set();
    const cap = Math.min(limit, this.RLE_PARTIAL_CAP);
    for (let len = 2; len <= cap; len++) palette.add(len);
    if (limit > cap) {
      palette.add(limit);
      for (let len = cap + this.RLE_LONG_STEP; len < limit; len += this.RLE_LONG_STEP) {
        palette.add(len);
      }
    }
    return Array.from(palette).sort((a, b) => b - a);
  }

  _matchLengthAtOffset(input, pos, offset, lenCache = null) {
    if (offset <= 0 || offset > pos) return 0;
    const cacheKey = lenCache ? `${pos}|${offset}` : null;
    if (cacheKey && lenCache.has(cacheKey)) return lenCache.get(cacheKey);
    const n = input.length >>> 0;
    const maxLen = Math.min(this.MAX_MATCH, n - pos);
    let length = 0;
    while (length < maxLen && input[pos + length] === input[pos - offset + length]) length++;
    if (cacheKey) lenCache.set(cacheKey, length);
    return length;
  }

  _isRLEOffset(offset) {
    return this.RLE_OFFSETS.includes(offset);
  }

  _needsPalettePass(input) {
    const n = input.length >>> 0;
    if (n < this.RLE_TRIGGER_LEN) return false;

    const offsets = Array.isArray(this.RLE_OFFSETS) && this.RLE_OFFSETS.length
      ? this.RLE_OFFSETS
      : [1, 2];

    for (const offset of offsets) {
      if (offset <= 0 || offset >= n) continue;
      let run = 0;
      for (let i = offset; i < n; i++) {
        if (input[i] === input[i - offset]) {
          run++;
          if (run + offset >= this.RLE_TRIGGER_LEN) return true;
        } else {
          run = 0;
        }
      }
    }
    return false;
  }

  _mergeStreams(baseStream, improvedStream, paletteLen, biasedLen) {
    if (
      improvedStream.length >= baseStream.length ||
      Math.abs(improvedStream.length - baseStream.length) <= Math.abs(paletteLen - baseStream.length)
    ) {
      return baseStream;
    }
    return improvedStream;
  }

  _singleOffset(input, pos) {
    const limit = Math.min(15, pos);
    for (let off = 1; off <= limit; off++) {
      if (input[pos] === input[pos - off]) return off;
    }
    return 0;
  }

  _findMatch(input, pos) {
    const n = input.length >>> 0;
    const maxOffset = Math.min(pos, this.MAX_OFFSET_SEARCH);
    let bestLen = 0;
    let bestOffset = 0;

    for (let offset = 1; offset <= maxOffset; offset++) {
      let length = 0;
      const maxLen = Math.min(this.MAX_MATCH, n - pos);
      while (length < maxLen && input[pos + length] === input[pos - offset + length]) length++;
      if (length > bestLen) {
        bestLen = length;
        bestOffset = offset;
      }
      if (bestLen >= 3 && bestLen === maxLen) break;
    }
    return { length: bestLen, offset: bestOffset };
  }

  _getCachedMatch(input, pos, cache = null) {
    if (!cache) return this._findMatch(input, pos);
    if (cache.has(pos)) return cache.get(pos);
    const match = this._findMatch(input, pos);
    cache.set(pos, match);
    return match;
  }

  _scoreOffsets(input) {
    const freq = new Map();
    let runStart = 0;
    for (let i = 1; i < input.length; i++) {
      if (input[i] !== input[i - 1]) {
        const runLen = i - runStart;
        for (let off = 1; off <= Math.min(32, runLen); off++) {
          freq.set(off, (freq.get(off) ?? 0) + runLen);
        }
        runStart = i;
      }
    }
    const tailLen = input.length - runStart;
    for (let off = 1; off <= Math.min(32, tailLen); off++) {
      freq.set(off, (freq.get(off) ?? 0) + tailLen);
    }

    const result = {};
    const maxVal = Math.max(...freq.values(), 1);
    for (const [offset, value] of freq.entries()) {
      result[offset] = Math.floor((value / maxVal) * 4);
    }
    return result;
  }

  _varBits(value) {
    if (value < 2) return 0;
    let bits = 0;
    let msb = 30;
    while (((value >> msb) & 1) === 0) msb--;
    while (msb > 0) {
      bits += 2;
      msb--;
    }
    bits += 2;
    return bits;
  }

  _shortRunCost(length) {
    if (length < 2) return 0;
    const tokens = Math.floor(length / 3) + (length % 3 ? 1 : 0);
    return tokens * SHORT_MATCH_COST;
  }

  _convertBlockToShortRun(match, pairState) {
    if (!match || match.kind !== "block") return null;
    if (match.offset > 127 || match.length < 4) return null;
    if (match.length > this.MAX_SHORT_RUN_LENGTH) return null;
    const blockBits = this._blockCost(match.offset, match.length, pairState);
    const runBits = this._shortRunCost(match.length);
    if (!Number.isFinite(blockBits) || runBits >= blockBits - 1) return null;
    return { kind: "shortRun", offset: match.offset, length: match.length, cost: runBits };
  }

  _blockCost(offset, length, pairState) {
    const delta = this._lengthDelta(offset);
    if (length < delta + 2) return Infinity;
    const storedLen = length - delta;
    if (storedLen < 2) return Infinity;
    const high = offset >>> 8;
    const varOffset = (pairState ? (high + 3) : (high + 2)) >>> 0;
    return 2 + this._varBits(varOffset) + 8 + this._varBits(storedLen);
  }

  _splitBlockMatch(match, pairState) {
    const offset = match.offset;
    if (offset > 127) return null;
    const splits = [3, 2];
    for (const splitLen of splits) {
      if (match.length <= splitLen + 2) continue;
      const remaining = match.length - splitLen;
      const blockCost = this._blockCost(offset, remaining, false);
      if (!Number.isFinite(blockCost)) continue;
      const splitCost = SHORT_MATCH_COST + blockCost;
      if (splitCost + 1 < match.cost) {
        return {
          first: { kind: "short", offset, length: splitLen, cost: SHORT_MATCH_COST },
          second: { kind: "block", offset, length: remaining, cost: blockCost },
        };
      }
    }
    return null;
  }

  _tryDPCompression(input) {
    try {
      const matches = this._buildDPMatchLists(input);
      if (!matches) return null;
      const plan = this._planDP(input, matches);
      if (!plan) return null;
      return this._emitDPPlan(input, plan.ops);
    } catch {
      return null;
    }
  }

  _buildDPMatchLists(input) {
    const n = input.length >>> 0;
    if (n < 4) return null;
    const HASH_BITS = 15;
    const HASH_SIZE = 1 << HASH_BITS;
    const HASH_MASK = HASH_SIZE - 1;
    const head = new Int32Array(HASH_SIZE);
    head.fill(-1);
    const link = new Int32Array(n);
    link.fill(-1);
    const matches = Array.from({ length: n }, () => []);

    const hashAt = (pos) => {
      if (pos + 2 >= n) return -1;
      return ((input[pos] << 16) ^ (input[pos + 1] << 8) ^ input[pos + 2]) & HASH_MASK;
    };

    const record = (list, offset, length) => {
      if (offset <= 0 || offset > this.MAX_OFFSET_SEARCH) return;
      if (length < 2) return;
      const existing = list.find((m) => m.offset === offset);
      if (existing) {
        if (length > existing.length) existing.length = length;
        return;
      }
      list.push({ offset, length });
    };

    for (let i = 1; i < n; i++) {
      const arr = matches[i];
      const h = hashAt(i);
      if (h >= 0) {
        let pos = head[h];
        let hits = 0;
        const maxLen = Math.min(this.MAX_MATCH, n - i);
        while (pos >= 0 && hits < this.DP_MAX_CHAIN) {
          const offset = i - pos;
          if (offset > 0 && offset <= this.MAX_OFFSET_SEARCH) {
            let len = 0;
            while (len < maxLen && input[i + len] === input[pos + len]) len++;
            if (len >= 2) record(arr, offset, len);
          }
          pos = link[pos];
          hits++;
        }
      }

      for (const off of [1, 2]) {
        if (off > i) continue;
        let len = 0;
        const maxLen = Math.min(this.MAX_MATCH, n - i);
        while (len < maxLen && input[i + len] === input[i + len - off]) len++;
        if (len >= 2) record(arr, off, len);
      }

      arr.sort((a, b) => b.length - a.length || a.offset - b.offset);
      if (arr.length > this.DP_MAX_MATCHES) arr.length = this.DP_MAX_MATCHES;

      if (h >= 0) {
        link[i] = head[h];
        head[h] = i;
      }
    }
    return matches;
  }

  _planDP(input, matchLists) {
    const n = input.length >>> 0;
    const INF = 1e12;
    const dp = Array.from({ length: n + 1 }, () => [new Map(), new Map()]);
    const prev = Array.from({ length: n + 1 }, () => [new Map(), new Map()]);
    dp[n][0].set(0, 0);
    dp[n][1].set(0, 0);

    for (let i = n - 1; i >= 1; i--) {
      for (let pairState = 0; pairState <= 1; pairState++) {
        for (const [lastOffset, baseCost] of dp[i + 1][pairState].entries()) {
          const cost = baseCost + LITERAL_COST;
          const map = dp[i][1];
          const existing = map.get(lastOffset);
          if (existing === undefined || cost < existing) {
            map.set(lastOffset, cost);
            prev[i][1].set(lastOffset, {
              prevPos: i + 1,
              prevPair: pairState,
              prevOffset: lastOffset,
              op: { type: "lit" },
            });
          }
        }
      }

      let singleOff = this._singleOffset(input, i);
      if (!singleOff && this.ALLOW_SINGLE_ZERO && input[i] === 0) singleOff = 0;
      if (singleOff || singleOff === 0) {
        for (let pairState = 0; pairState <= 1; pairState++) {
          for (const [lastOffset, baseCost] of dp[i + 1][pairState].entries()) {
            const cost = baseCost + SINGLE_MATCH_COST;
            const map = dp[i][1];
            const existing = map.get(lastOffset);
            if (existing === undefined || cost < existing) {
              map.set(lastOffset, cost);
              prev[i][1].set(lastOffset, {
                prevPos: i + 1,
                prevPair: pairState,
                prevOffset: lastOffset,
                op: { type: "single", offset: singleOff },
              });
            }
          }
        }
      }

      const candidates = matchLists[i] || [];
      for (const match of candidates) {
        const offset = match.offset;
        const maxLen = match.length;
        for (let len = Math.min(maxLen, this.MAX_MATCH); len >= 2; len--) {
          const delta = this._lengthDelta(offset);
          if (len < delta + 2) continue;
          const storedLen = len - delta;
          if (storedLen < 2) continue;
          const cost =
            2 + this._varBits(((offset >>> 8) + 2) >>> 0) + 8 + this._varBits(storedLen);
          const nextPos = Math.min(input.length, i + len);
          for (const [lastOffset, baseCost] of dp[nextPos][0].entries()) {
            const total = baseCost + cost;
            const map = dp[i][0];
            const existing = map.get(offset);
            if (existing === undefined || total < existing) {
              map.set(offset, total);
              prev[i][0].set(offset, {
                prevPos: nextPos,
                prevPair: 0,
                prevOffset: offset,
                op: { type: "block", offset, length: len },
              });
            }
          }
        }
      }
    }

    let bestCost = INF;
    let bestPair = 1;
    let bestOffset = 0;
    for (let pairState = 0; pairState <= 1; pairState++) {
      for (const [lastOffset, cost] of dp[1][pairState].entries()) {
        if (cost < bestCost) {
          bestCost = cost;
          bestPair = pairState;
          bestOffset = lastOffset;
        }
      }
    }
    if (!Number.isFinite(bestCost)) return null;

    const ops = [];
    let pos = 1;
    let pair = bestPair;
    let offset = bestOffset;
    while (pos < input.length) {
      const info = prev[pos][pair].get(offset);
      if (!info) break;
      ops.push(info.op);
      pos = info.prevPos;
      pair = info.prevPair;
      offset = info.prevOffset;
    }
    if (!ops.length) return null;
    return { ops };
  }

  _emitDPPlan(input, ops) {
    const n = input.length >>> 0;
    const out = [input[0]];
    const W = this._beginWriter(out);
    let pair = true;
    let lastOffset = 0;
    let i = 1;

    for (const op of ops) {
      if (i >= n) break;
      switch (op.type) {
        case "lit":
          W.writeBit(0);
          W.writeByte(input[i]);
          pair = true;
          i += 1;
          break;
        case "single": {
          let off = op.offset;
          if (off === undefined || off === null) {
            off = this._singleOffset(input, i);
            if (!off && this.ALLOW_SINGLE_ZERO && input[i] === 0) off = 0;
          }
          if (off === undefined || off === null) off = 1;
          W.writeBits([1, 1, 1]);
          W.writeBit((off >> 3) & 1);
          W.writeBit((off >> 2) & 1);
          W.writeBit((off >> 1) & 1);
          W.writeBit(off & 1);
          pair = true;
          i += 1;
          break;
        }
        case "block": {
          const offset = op.offset | 0;
          const length = op.length | 0;
          const high = (offset >>> 8) & 0xffff;
          const low = offset & 0xff;
          W.writeBits([1, 0]);
          const varOffset = (pair ? (high + 3) : (high + 2)) >>> 0;
          W.writeVarNumber(varOffset);
          W.writeByte(low);
          const delta = this._lengthDelta(offset);
          const storedLen = (length - delta) | 0;
          W.writeVarNumber(storedLen);
          lastOffset = offset;
          pair = false;
          i += length;
          break;
        }
      }
    }

    W.endStream();
    return new Uint8Array(W.out);
  }
}
