# RetroCompress Lite - Modular Architecture

A modern, extensible compression tool for classic 8-bit compression algorithms with a clean modular architecture.

## 🏗️ Architecture Overview

The application is now structured with a modular design for easy maintenance and extension:

```
RetroCompress Lite/
├── index.html                    # Main HTML file
├── js/
│   ├── codecConfig.js            # Codec configuration and loading system
│   ├── app.js                    # Main application logic
│   ├── utils.js                  # Utility functions
│   └── codecs/                   # Individual codec modules
│       ├── aplib.js              # aPLib compression codec
│       ├── bitbuster12.js        # BitBuster 1.2 compression codec
│       ├── dan1.js               # DAN1 compression codec
│       ├── dan2.js               # DAN2 compression codec
│       ├── dan3.js               # DAN3 compression codec
│       ├── lzf.js                # LZF compression codec
│       ├── mdkrle.js             # MdK-RLE compression codec
│       ├── nibble.js             # Nibble RLE + data-table reference codec
│       ├── pletter.js            # Pletter 0.5 codec
│       ├── zx7.js                # ZX7 optimal compression codec
│       └── zx0.js                # ZX0 state-of-the-art codec
└── README.md                     # This file
```

## 🚀 Features

### Universal File Support
- **Raw Files**: Compress any file in all available formats
- **Compressed Files**: Auto-detect format and decompress, then recompress in other formats
- **Format Conversion**: Convert between different compression formats seamlessly

### Smart Workflow
1. **File Analysis**: Detailed information about uploaded files
2. **Auto-Detection**: Recognizes compressed files by extension
3. **Decompression**: Extracts data from compressed files
4. **Multi-Format Compression**: Tests all available codecs
5. **Results Comparison**: Sorted by compression efficiency

### Modular Codec System
- **Easy Extension**: Add new codecs by dropping files in `/js/codecs/`
- **Configuration-Driven**: All codec metadata in `codecConfig.js`
- **Runtime Loading**: Codecs loaded dynamically with error handling
- **Interface Validation**: Ensures all codecs implement required methods

## 📦 Supported Formats

| Codec | Author | Year | Description | Extensions |
|-------|--------|------|-------------|------------|
| **DAN3** | Amy Bienvenu | 2018 | Modern LZSS tuned for ColecoVision assets | `.dan3` |
| **DAN1** | Amy Bienvenu | 2016 | Lightweight DAN-series ancestor for quick passes | `.dan1` |
| **DAN2** | Daniel Bienvenu aka NewColeco | 2017 | DAN1-derived LZ77 with variable high-offset bit-width header | `.dan2` |
| **MDK-RLE** | Marcel deKogel | 1998 | ColecoVision/ADAM-ready RLE | `.mdk`, `.rle` |
| **Nibble** | Amy Bienvenu | 2010/2026 | Legacy DAN0nibble-style RLE with 16-value data-stream references | .nibble |
| **BitBuster 1.2** | Arjan “MrBaker” Bakker | 2003 | MSX-oriented LZ77 with variable token costs | `.pck` |
| **LZF (ZX Spectrum)** | Marc Lehmann, Tom Dalby | 2005‑2020 | Fast byte-aligned LZ77 with 0xFF end marker | `.lzf` |
| **Pletter 0.5** | XL2S Entertainment | 2008 | “BitBuster on steroids” for MSX | `.plet5` |
| **ZX7** | Einar Saukas | 2012 | Optimal parse LZ77 for 8-bit screens | `.zx7` |
| **ZX0** | Einar Saukas (& Urusergi) | 2021 | Successor to ZX7: smaller output, faster decode | `.zx0` |
| **aPLib** | Jørgen Ibsen | 1998 | Beam-search encoder with reuse seeding & near-match bias | `.apl`, `.aplib` |

### Note about the Nibble codec name

`Nibble` in this project is the public RetroCompress-Lite name for Amy/NewColeco's legacy `DAN0nibble`-derived ColecoVision format. It is not intended to describe or claim compatibility with other unrelated compressors named “nibble” in other 8-bit homebrew scenes, including Amstrad CPC tooling. This implementation preserves the DAN0nibble-style command semantics and adds a relocatable 2026 stream header for browser/project-file use.

Historical source: the public AtariAge ColecoVision Programming thread “DAN0 - My proposed compression algorithm”, posted by `newcoleco` on March 19, 2010. In that thread, DAN0 was presented as an RLE-first improvement over Marcel de Kogel's Coleco library RLE: keep RLE because it is fast on ColecoVision, then improve the encoded data stream to save more ROM space. The same discussion records later cleanup of `di`/`ei` around VDP routines and compares DAN0 with early DAN1 ideas. A concrete GhostBlaster-era result reported there was 32,621 bytes with Marcel's RLE versus 29,732 bytes after DAN0, saving 2,889 bytes, about 8% of a 32KB cartridge.

## 🔧 Adding New Codecs

### Step 1: Create Codec Module

Create a new file in `/js/codecs/yourcodec.js`:

```javascript
/**
 * Your Codec Name
 * Description and attribution
 */

export class YourCodec {
    constructor() {
        // Initialize codec
    }

    /**
     * Compress data (required method)
     * @param {Uint8Array} data - Input data
     * @param {Object} options - Compression options
     * @returns {Promise<Uint8Array>} Compressed data
     */
    async compress(data, options = {}) {
        // Your compression implementation
        return new Uint8Array([/* compressed data */]);
    }

    /**
     * Decompress data (required method)
     * @param {Uint8Array} compressedData - Compressed input
     * @param {Object} options - Decompression options
     * @returns {Promise<Uint8Array>} Decompressed data
     */
    async decompress(compressedData, options = {}) {
        // Your decompression implementation
        return new Uint8Array([/* decompressed data */]);
    }

    // Optional: Add codec-specific methods
    getCompressionStats() {
        return { /* statistics */ };
    }
}
```

### Step 2: Update Configuration

Add your codec to `codecConfig.js`:

```javascript
export const CODEC_CONFIG = {
    formats: {
        // ... existing codecs ...
        yourcodec: {
            name: 'Your Codec Name',
            author: 'Your Name',
            year: '2024',
            description: 'Description of your codec',
            extensions: ['.yourext'],
            module: './js/codecs/yourcodec.js',
            className: 'YourCodec',
            enabled: true,
            category: 'custom'
        }
    }
    // ... rest of config
};
```

### Step 3: Test Your Codec

The system will automatically:
- Load your codec on startup
- Validate the interface (compress/decompress methods)
- Display status in the codec status panel
- Include it in compression comparisons

## 🛠️ Development

### Required Interface

All codecs must implement:

```javascript
class CodecInterface {
    async compress(data, options) {
        // Must return Promise<Uint8Array>
    }
    
    async decompress(compressedData, options) {
        // Must return Promise<Uint8Array>
    }
}
```

### Configuration Options

```javascript
{
    name: 'Display Name',           // Required: Shown in UI
    author: 'Author Name',          // Required: Attribution
    year: 'YYYY',                   // Required: Release year
    description: 'Description',     // Required: Tooltip text
    extensions: ['.ext1', '.ext2'], // Required: File extensions
    module: './path/to/module.js',  // Required: ES6 module path
    className: 'ClassName',         // Required: Export class name
    enabled: true,                  // Optional: Enable/disable
    category: 'category'            // Optional: Grouping
}
```

### Error Handling

The system includes comprehensive error handling:
- **Module Loading**: Failed modules are logged and skipped
- **Interface Validation**: Missing methods are detected
- **Runtime Errors**: Compression/decompression failures are caught
- **User Feedback**: Clear error messages in the UI

## 🎯 Use Cases

### Format Conversion
Drop a `.zx7` file → Get `.dan3`, `.plet5`, `.zx0` versions

### Compression Comparison
Upload any file → See which codec gives the best ratio

### Decompression Tool
Extract original data from any supported compressed file

### Development Testing
Test your codec against established formats

## 📈 Performance Considerations

- **Asynchronous Processing**: All codecs use async/await
- **Memory Management**: Large files handled efficiently
- **Progress Indication**: Visual feedback during processing
- **Error Recovery**: Graceful handling of codec failures

## 🔍 Debugging

Enable debug mode in `codecConfig.js`:

```javascript
settings: {
    enableDebugMode: true
}
```

This provides:
- Detailed console logging
- Codec loading information
- Performance timing
- Error stack traces

## 📝 License & Attribution

This project is a modular framework designed to preserve and celebrate the history of 8-bit compression. Full credit goes to the original authors:

- **aPLib**: © 1998 Jørgen Ibsen.
- **BitBuster 1.2**: © 2003 Arjan “MrBaker” Bakker.
- **ZX0 / ZX7**: © 2012-2021 Einar Saukas.
- **Pletter**: © 2008 XL2S Entertainment (Sander Zuidema).
- **DAN1 / DAN3**: © 2016-2018 Amy Bienvenu (formerly Daniel Bienvenu / NewColeco).
- **Nibble**: © Amy Bienvenu / NewColeco, based on the legacy DAN0nibble decompressor idea.
- **MDK-RLE**: © 1998 Marcel de Kogel.
- **LZF**: © 2000-2010 Marc Alexander Lehmann.

The modular architecture and web interface are designed for educational and preservation purposes, maintaining full attribution to the original algorithm creators.

## 🤝 Contributing

To contribute a new codec:

1. Implement the required interface
2. Add comprehensive tests
3. Update the configuration
4. Submit with proper attribution
5. Include documentation and examples

The goal is to preserve and celebrate the innovation of classic compression algorithms while making them accessible through modern web technologies.

