/**
 * Main Application Logic for RetroCompress Lite
 * Handles UI interactions, file processing, and workflow management
 */

import { detectCompressionFormat, getFileExtension, getEnabledCodecsInOrder, getEnabledCodecCount } from './codecConfig.js';
import * as Utils from './utils.js';

export class RetroCompressApp {
    constructor(codecs, codecConfig) {
        this.codecs = codecs;
        this.codecConfig = codecConfig;
        this.originalData = null;
        this.decompressedData = null;
        this.originalFileName = '';
        this.compressionFormat = null;
        this.allCompressionResults = [];

        console.log('RetroCompress App initialized with', Object.keys(codecs).length, 'codecs');
    }

    /**
     * Handle file upload/drop
     * @param {File} file - The uploaded file
     */
    async handleFile(file) {
        if (!file) return;

        this.originalFileName = file.name.split('.')[0] || 'file';
        document.getElementById('fileName').textContent = file.name;

        // Reset sections
        this.resetWorkflow();

        const reader = new FileReader();
        reader.onload = async (e) => {
            this.originalData = new Uint8Array(e.target.result);
            this.compressionFormat = detectCompressionFormat(file.name);

            this.showStatus(`File loaded: ${file.name} (${Utils.formatFileSize(this.originalData.length)})`, 'info');
            document.getElementById('processingIndicator').classList.remove('hidden');

            await this.processFile(file.name, this.originalData, this.compressionFormat);

            document.getElementById('processingIndicator').classList.add('hidden');
        };

        reader.onerror = () => {
            this.showStatus('Error reading file', 'error');
            document.getElementById('processingIndicator').classList.add('hidden');
        };

        reader.readAsArrayBuffer(file);
    }

    /**
     * Process the loaded file
     * @param {string} fileName - Name of the file
     * @param {Uint8Array} data - File data
     * @param {string|null} format - Detected compression format
     */
    async processFile(fileName, data, format) {
        // Show file analysis
        this.displayFileAnalysis(fileName, data, format);

        if (format) {
            // Try to decompress first
            await this.attemptDecompression(data, format);

            if (this.decompressedData) {
                // Compress the decompressed data in all formats
                await this.runAllCompressions(this.decompressedData);
            } else {
                this.showStatus('Decompression failed - treating as raw data', 'warning');
                await this.runAllCompressions(data);
            }
        } else {
            // Raw file - just compress in all formats
            await this.runAllCompressions(data);
        }

        this.displaySortedResults();
    }

    /**
     * Display file analysis information
     * @param {string} fileName - Name of the file
     * @param {Uint8Array} data - File data
     * @param {string|null} format - Detected format
     */
    displayFileAnalysis(fileName, data, format) {
        const analysisSection = document.getElementById('fileAnalysisSection');
        const content = document.getElementById('fileAnalysisContent');

        const crc32 = '0x' + Utils.calculateCrc32(data).toString(16).toUpperCase().padStart(8, '0');

        content.innerHTML = `
            <div class="file-info-box">
                <h3>FILE INFORMATION</h3>
                <p>NAME: <span style="color: #FFFF00;">${fileName}</span></p>
                <p>SIZE: <span style="color: #FFFF00;">${Utils.formatFileSize(data.length)}</span> (${data.length} bytes)</p>
                <p>CRC-32: <span style="color: #FFFF00;">${crc32}</span></p>
                <p>TYPE: <span style="color: ${format ? '#FF6600' : '#00FF00'};">${format ? `COMPRESSED (${format.toUpperCase()})` : 'RAW DATA'}</span></p>
            </div>
            <div class="file-info-box">
                <h3>DATA PREVIEW</h3>
                <pre style="background: #0d0d0d; padding: 10px; font-size: 0.8em; border: 1px solid #006600; margin-top: 10px;">${Utils.arrayToHex(data, 128)}</pre>
            </div>
        `;

        analysisSection.classList.remove('hidden');
    }

    /**
     * Attempt to decompress the file
     * @param {Uint8Array} data - Compressed data
     * @param {string} format - Compression format
     */
    async attemptDecompression(data, format) {
        const decompressionSection = document.getElementById('decompressionSection');
        const content = document.getElementById('decompressionContent');

        try {
            const codec = this.codecs[format];
            if (!codec) {
                throw new Error(`Codec ${format} not available`);
            }

            const { result, duration } = await Utils.timeOperation(
                `${format.toUpperCase()} decompression`,
                () => codec.decompress(data, {})
            );
            this.decompressedData = result;
            const decompressedCrc = '0x' + Utils.calculateCrc32(this.decompressedData).toString(16).toUpperCase().padStart(8, '0');

            const ratio = ((data.length / this.decompressedData.length) * 100).toFixed(2);
            const codecInfo = this.codecConfig.formats[format];

            content.innerHTML = `
                <div class="file-info-box">
                    <h3>DECOMPRESSION SUCCESS</h3>
                    <p>CODEC: <span style="color: #00FFFF;">${codecInfo.name}</span></p>
                    <p>AUTHOR: <span style="color: #009900;">${codecInfo.author}</span></p>
                    <p>TIME: <span style="color: #00FF00;">${duration.toFixed(2)} ms</span></p>
                    <p>ORIGINAL SIZE: <span style="color: #FFFF00;">${Utils.formatFileSize(data.length)}</span></p>
                    <p>DECOMPRESSED SIZE: <span style="color: #00FF00;">${Utils.formatFileSize(this.decompressedData.length)}</span></p>
                    <p>COMPRESSION RATIO: <span style="color: #00FF00;">${ratio}%</span></p>
                    <p>DECOMPRESSED CRC-32: <span style="color: #FFFF00;">${decompressedCrc}</span></p>
                    <div style="margin-top: 15px;">
                        <button class="action-button secondary" onclick="downloadDecompressed()">DOWNLOAD DECOMPRESSED</button>
                        <button class="action-button secondary" onclick="useDecompressedAsInput()">USE AS NEW INPUT</button>
                    </div>
                </div>
                <div class="file-info-box">
                    <h3>DECOMPRESSED DATA PREVIEW</h3>
                    <pre style="background: #0d0d0d; padding: 10px; font-size: 0.8em; border: 1px solid #006600; margin-top: 10px;">${Utils.arrayToHex(this.decompressedData, 128)}</pre>
                </div>
            `;

            decompressionSection.classList.remove('hidden');
            this.showStatus(`Successfully decompressed ${format.toUpperCase()} file`, 'success');

        } catch (error) {
            content.innerHTML = `
                <div class="file-info-box">
                    <h3>DECOMPRESSION FAILED</h3>
                    <p style="color: #FF0000;">ERROR: ${error.message}</p>
                    <p>Treating file as raw data instead.</p>
                </div>
            `;
            decompressionSection.classList.remove('hidden');
            this.decompressedData = null;
        }
    }

    /**
     * Run compression with all available codecs
     * @param {Uint8Array} data - Data to compress
     */
    async runAllCompressions(data) {
        const codecOrder = getEnabledCodecsInOrder();
        const enabledCount = getEnabledCodecCount();

        if (enabledCount === 0) {
            this.showStatus('No codecs enabled for compression testing', 'error');
            return;
        }

        this.allCompressionResults = [];
        console.log(`Running compression with ${enabledCount} enabled codecs:`, codecOrder);

        for (const codecName of codecOrder) {
            if (!this.codecs[codecName]) {
                console.warn(`Codec ${codecName} not available, skipping`);
                continue;
            }

            const codec = this.codecs[codecName];
            let compressedData = null, testDecompressedData = null;
            let compressionSuccess = false, decompressionSuccess = false;
            let compressionError = '', decompressionError = '', ratio = 0;
            let compressionTime = 0, decompressionTime = 0;

            try {
                const compResult = await Utils.timeOperation(
                    `${codecName} compression`,
                    () => codec.compress(data, {})
                );
                compressedData = compResult.result;
                compressionTime = compResult.duration;
                compressionSuccess = true;
                ratio = ((1 - (compressedData.length / data.length)) * 100);
            } catch (e) {
                compressionError = e.message;
            }

            if (compressionSuccess && compressedData) {
                try {
                    const decompResult = await Utils.timeOperation(
                        `${codecName} validation decompression`,
                        () => codec.decompress(compressedData, {})
                    );
                    testDecompressedData = decompResult.result;
                    decompressionTime = decompResult.duration;
                    decompressionSuccess = (data.length === testDecompressedData.length &&
                        Utils.calculateCrc32(data) === Utils.calculateCrc32(testDecompressedData));
                } catch (e) {
                    decompressionError = e.message;
                }
            }

            this.allCompressionResults.push({
                codecName,
                originalData: data,
                compressedData,
                testDecompressedData,
                compressionSuccess,
                decompressionSuccess,
                compressionError,
                decompressionError,
                ratio: parseFloat(ratio),
                compressionTime,
                decompressionTime,
            });
        }

        this.showStatus(`Compression completed with ${enabledCount} codecs`, 'success');
    }

    /**
     * Display compression results sorted by efficiency
     */
    displaySortedResults() {
        this.allCompressionResults.sort((a, b) => b.ratio - a.ratio);
        const container = document.getElementById('compressionContent');
        const section = document.getElementById('compressionSection');
        container.innerHTML = '';

        this.allCompressionResults.forEach(result => {
            const resultBox = document.createElement('div');
            resultBox.className = 'result-box';

            let validationMessage = '', validationColor = '#FF0000';
            if (!result.compressionSuccess) {
                validationMessage = `❌ COMPRESSION FAILED: ${result.compressionError}`;
            } else if (!result.decompressionSuccess) {
                validationMessage = `❌ DECOMPRESSION FAILED: ${result.decompressionError || 'DATA MISMATCH'}`;
            } else {
                validationMessage = '✅ DECOMPRESSION VALIDATED';
                validationColor = '#00FF00';
            }

            const compressedSize = result.compressedData ? result.compressedData.length : 0;
            const originalCrc = '0x' + Utils.calculateCrc32(result.originalData).toString(16).toUpperCase().padStart(8, '0');
            const decompressedCrc = result.testDecompressedData ?
                '0x' + Utils.calculateCrc32(result.testDecompressedData).toString(16).toUpperCase().padStart(8, '0') : 'N/A';

            const info = this.codecConfig.formats[result.codecName];

            resultBox.innerHTML = `
                <h3 title="${info.description}">${info.name}</h3>
                <div class="codec-info">
                    <p>BY ${info.author.toUpperCase()} (${info.year})</p>
                </div>
                <div class="status-info">
                    <p>COMPRESSED SIZE: <span>${Utils.formatFileSize(compressedSize)}</span> (${compressedSize} bytes)</p>
                    <p>COMPRESSION RATIO: <span>${result.ratio.toFixed(2)}%</span></p>
                    <p>COMPRESS TIME: <span style="color: #00FFFF;">${result.compressionTime.toFixed(2)} ms</span></p>
                    <p>DECOMPRESS TIME: <span style="color: #00FFFF;">${result.decompressionTime.toFixed(2)} ms</span></p>
                    <p>ORIGINAL CRC-32: <span>${originalCrc}</span></p>
                    <p>DECOMPRESSED CRC-32: <span>${decompressedCrc}</span></p>
                    <p style="color:${validationColor};">${validationMessage}</p>
                </div>
                <pre>${Utils.arrayToHex(result.compressedData)}</pre>
                ${result.compressionSuccess ?
                    `<button class="action-button download-btn" data-codec="${result.codecName}">DOWNLOAD ${info.name.toUpperCase()}</button>` :
                    `<button class="action-button" disabled>DOWNLOAD (FAILED)</button>`}
            `;

            container.appendChild(resultBox);

            if (result.compressionSuccess) {
                resultBox.querySelector('.download-btn').addEventListener('click', (e) => {
                    const codec = e.target.dataset.codec;
                    const extension = getFileExtension(codec);
                    const filename = `${this.originalFileName}_${codec}${extension}`;
                    Utils.downloadBlob(result.compressedData, filename);
                    this.showStatus(`Downloaded: ${filename}`, 'success');
                });
            }
        });

        section.classList.remove('hidden');
    }

    /**
     * Download decompressed data
     */
    downloadDecompressed() {
        if (this.decompressedData) {
            const filename = `${this.originalFileName}_decompressed.bin`;
            Utils.downloadBlob(this.decompressedData, filename);
            this.showStatus(`Downloaded: ${filename}`, 'success');
        }
    }

    /**
     * Use decompressed data as new input
     */
    useDecompressedAsInput() {
        if (this.decompressedData) {
            // Reset everything and use decompressed data as new input
            this.resetWorkflow();
            this.originalData = new Uint8Array(this.decompressedData);
            this.compressionFormat = null;
            this.originalFileName = this.originalFileName + '_decompressed';

            document.getElementById('fileName').textContent = `${this.originalFileName}.bin (from decompression)`;

            // Show file analysis for decompressed data
            this.displayFileAnalysis(`${this.originalFileName}.bin`, this.originalData, null);

            // Process as raw data
            document.getElementById('processingIndicator').classList.remove('hidden');
            setTimeout(async () => {
                await this.runAllCompressions(this.originalData);
                this.displaySortedResults();
                document.getElementById('processingIndicator').classList.add('hidden');
                this.showStatus('Recompressed decompressed data in all formats', 'success');
            }, 100);
        }
    }

    /**
     * Reset the workflow to initial state
     */
    resetWorkflow() {
        // Hide all workflow sections
        document.getElementById('fileAnalysisSection').classList.add('hidden');
        document.getElementById('decompressionSection').classList.add('hidden');
        document.getElementById('compressionSection').classList.add('hidden');
        document.getElementById('statusMessage').classList.add('hidden');

        // Reset data
        this.decompressedData = null;
        this.allCompressionResults = [];
    }

    /**
     * Show status message
     * @param {string} message - Message to display
     * @param {string} type - Message type (success, error, warning, info)
     */
    showStatus(message, type) {
        const statusDiv = document.getElementById('statusMessage');
        statusDiv.textContent = message;
        statusDiv.className = `status-message ${type}`;
        statusDiv.classList.remove('hidden');
    }

    /**
     * Refresh the list of enabled codecs (called when user toggles codecs)
     */
    refreshEnabledCodecs() {
        const enabledCount = getEnabledCodecCount();
        if (enabledCount === 0) {
            this.showStatus('⚠️ No codecs enabled for compression testing!', 'warning');
        }
        console.log(`Refreshed codec list: ${enabledCount} codecs enabled`);
    }

}
