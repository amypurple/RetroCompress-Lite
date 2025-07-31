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
│       ├── dan3.js              # DAN3 compression codec
│       ├── lzf.js               # LZF compression codec
│       ├── mdkrle.js            # MdK-RLE compression codec
│       ├── pletter.js           # Pletter v0.5 codec
│       ├── zx7.js               # ZX7 optimal compression codec
│       └── zx0.js               # ZX0 state-of-the-art codec
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
| **DAN3** | Amy Bienvenu | 2018 | Modern LZSS for ColecoVision | `.dan3` |
| **MDK-RLE** | Marcel deKogel | 1998 | RLE for ColecoVision and Coleco ADAM | `.mdkrle` |
| **LZF** | Marc Lehmann | 2005 | Fast byte-aligned LZ77 | `.lzf` |
| **Pletter** | XL2S Entertainment | 2008 | Fast Z80 decompressor for MSX | `.plet5` |
| **ZX7** | Einar Saukas | 2012 | Optimal LZ77 for ZX Spectrum | `.zx7` |
| **ZX0** | Einar Saukas | 2021 | State-of-the-art evolution of ZX7 | `.zx0` |

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

This modular system preserves the original codec licenses and attributions:

- **DAN3**: © 2018 Amy Bienvenu (NewColeco)
- **Pletter**: © 2008 XL2S Entertainment (Sander Zuidema)
- **ZX7**: © 2012 Einar Saukas
- **ZX0**: © 2021 Einar Saukas

The modular architecture and web interface are designed for educational and preservation purposes, maintaining full attribution to the original algorithm creators.

## 🤝 Contributing

To contribute a new codec:

1. Implement the required interface
2. Add comprehensive tests
3. Update the configuration
4. Submit with proper attribution
5. Include documentation and examples

The goal is to preserve and celebrate the innovation of classic compression algorithms while making them accessible through modern web technologies.
