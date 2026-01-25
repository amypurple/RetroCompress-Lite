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
        this.isProcessing = false;
        this.statusHideTimer = null;
        this.statusAutoHideDelay = 5000;

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

        // Reset sections and prepare placeholders
        this.resetWorkflow();
        this.totalCodecCount = getEnabledCodecCount();
        this.updateCompressionResultsUI();
        this.showStatus('Loading file…', 'info');
        await this.yieldToUI();

        const reader = new FileReader();
        reader.onload = async (e) => {
            this.originalData = new Uint8Array(e.target.result);
            this.compressionFormat = detectCompressionFormat(file.name);

            this.showStatus(`Analyzing ${file.name} (${Utils.formatFileSize(this.originalData.length)})`, 'info');
            await this.yieldToUI();

            await this.processFile(file.name, this.originalData, this.compressionFormat);
        };

        reader.onerror = () => {
            this.showStatus('Error reading file', 'error');
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
                <p>NAME: <span class="text-accent-yellow">${fileName}</span></p>
                <p>SIZE: <span class="text-accent-yellow">${Utils.formatFileSize(data.length)}</span> (${data.length} bytes)</p>
                <p>CRC-32: <span class="text-accent-yellow">${crc32}</span></p>
                <p>TYPE: <span class="${format ? 'text-accent-orange' : 'text-accent-green'}">${format ? `COMPRESSED (${format.toUpperCase()})` : 'RAW DATA'}</span></p>
            </div>
            <div class="file-info-box">
                <h3>DATA PREVIEW</h3>
                <pre class="hex-preview">${Utils.arrayToHex(data, 128)}</pre>
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
            this.showStatus(`Decompressing with ${format.toUpperCase()}…`, 'info');
            await this.yieldToUI();
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
                    <p>CODEC: <span class="text-accent-cyan">${codecInfo.name}</span></p>
                    <p>AUTHOR: <span class="text-accent-emerald">${codecInfo.author}</span></p>
                    <p>TIME: <span class="text-accent-green">${duration.toFixed(2)} ms</span></p>
                    <p>ORIGINAL SIZE: <span class="text-accent-yellow">${Utils.formatFileSize(data.length)}</span></p>
                    <p>DECOMPRESSED SIZE: <span class="text-accent-green">${Utils.formatFileSize(this.decompressedData.length)}</span></p>
                    <p>COMPRESSION RATIO: <span class="text-accent-green">${ratio}%</span></p>
                    <p>DECOMPRESSED CRC-32: <span class="text-accent-yellow">${decompressedCrc}</span></p>
                    <div class="button-stack">
                        <button class="action-button secondary" onclick="downloadDecompressed()"><span>DOWNLOAD DECOMPRESSED</span></button>
                        <button class="action-button secondary" onclick="useDecompressedAsInput()"><span>USE AS NEW INPUT</span></button>
                    </div>
                </div>
                <div class="file-info-box">
                    <h3>DECOMPRESSED DATA PREVIEW</h3>
                    <pre class="hex-preview">${Utils.arrayToHex(this.decompressedData, 128)}</pre>
                </div>
            `;

            decompressionSection.classList.remove('hidden');
            this.showStatus(`Decompression via ${codecInfo.name} succeeded`, 'success');

        } catch (error) {
            content.innerHTML = `
                <div class="file-info-box">
                    <h3>DECOMPRESSION FAILED</h3>
                    <p class="text-error">ERROR: ${error.message}</p>
                    <p>Treating file as raw data instead.</p>
                </div>
            `;
            decompressionSection.classList.remove('hidden');
            this.decompressedData = null;
            this.showStatus(`Decompression failed (${format.toUpperCase()})`, 'error');
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

        this.totalCodecCount = enabledCount;
        this.allCompressionResults = [];
        this.updateCompressionResultsUI();
        this.showStatus('Starting compression sweep…', 'info');
        console.log(`Running compression with ${enabledCount} enabled codecs:`, codecOrder);

        for (const codecName of codecOrder) {
            if (!this.codecs[codecName]) {
                console.warn(`Codec ${codecName} not available, skipping`);
                continue;
            }

            const codec = this.codecs[codecName];
            const codecInfo = this.codecConfig.formats[codecName];
            let compressedData = null, testDecompressedData = null;
            let compressionSuccess = false, decompressionSuccess = false;
            let compressionError = '', decompressionError = '', ratio = 0;
            let compressionTime = 0, decompressionTime = 0;

            try {
                this.showStatus(`Compressing with ${codecInfo.name}…`, 'info');
                await this.yieldToUI();
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
                    this.showStatus(`Validating ${codecInfo.name} output…`, 'info');
                    await this.yieldToUI();
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
            this.updateCompressionResultsUI();
            await new Promise(resolve => requestAnimationFrame(resolve));

            if (compressionSuccess && decompressionSuccess) {
                this.showStatus(`${codecInfo.name} done (${ratio.toFixed(2)}% savings)`, 'success');
            } else if (compressionSuccess) {
                this.showStatus(`${codecInfo.name} compressed but validation failed`, 'warning');
            } else {
                this.showStatus(`${codecInfo.name} failed: ${compressionError}`, 'error');
            }
        }

        this.updateCompressionResultsUI();
        this.showStatus(`Compression completed with ${enabledCount} codecs`, 'success');
    }

    /**
     * Display compression results sorted by efficiency
     */
    displaySortedResults() {
        this.updateCompressionResultsUI();
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
            this.totalCodecCount = getEnabledCodecCount();
            this.updateCompressionResultsUI();
            this.showStatus('Recompressing decompressed data…', 'info');
            setTimeout(async () => {
                await this.runAllCompressions(this.originalData);
                this.displaySortedResults();
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
        this.hideStatusMessage(true);

        // Reset data
        this.decompressedData = null;
        this.allCompressionResults = [];
        this.totalCodecCount = 0;
        this.updateCompressionResultsUI();
    }

    /**
     * Show status message
     * @param {string} message - Message to display
     * @param {string} type - Message type (success, error, warning, info)
     */
    showStatus(message, type, options = {}) {
        const statusDiv = document.getElementById('statusMessage');
        if (!statusDiv) return;

        const shouldPersist = options.persist ?? (type === 'error');

        statusDiv.textContent = message;
        statusDiv.className = `status-message ${type}`;
        statusDiv.classList.remove('hidden', 'hiding', 'showing');

        // Force reflow so the animation restarts each time
        void statusDiv.offsetWidth;
        statusDiv.classList.add('showing');

        if (shouldPersist) {
            this.clearStatusHideTimer();
        } else {
            this.scheduleStatusHide();
        }
    }

    /**
     * Refresh the list of enabled codecs (called when user toggles codecs)
     */
    refreshEnabledCodecs() {
        const enabledCount = getEnabledCodecCount();
        if (enabledCount === 0) {
            this.showStatus('⚠ No codecs enabled for compression testing!', 'warning');
        }
        console.log(`Refreshed codec list: ${enabledCount} codecs enabled`);
    }

    async yieldToUI() {
        return new Promise(resolve => requestAnimationFrame(resolve));
    }

    updateCompressionResultsUI() {
        const container = document.getElementById('compressionContent');
        const section = document.getElementById('compressionSection');
        if (!container || !section) return;

        const total = this.totalCodecCount || this.allCompressionResults.length;

        container.innerHTML = '';
        if (this.allCompressionResults.length > 0) {
            this.allCompressionResults.sort((a, b) => b.ratio - a.ratio);
        }

        this.allCompressionResults.forEach(result => {
            const resultBox = document.createElement('div');
            resultBox.className = 'result-box';

            let validationMessage = '';
            if (!result.compressionSuccess) {
                validationMessage = `⚠ COMPRESSION FAILED: ${result.compressionError}`;
            } else if (!result.decompressionSuccess) {
                validationMessage = `⚠ DECOMPRESSION FAILED: ${result.decompressionError || 'DATA MISMATCH'}`;
            } else {
                validationMessage = '✔ DECOMPRESSION VALIDATED';
            }

            const compressedSize = result.compressedData ? result.compressedData.length : 0;
            const originalCrc = '0x' + Utils.calculateCrc32(result.originalData).toString(16).toUpperCase().padStart(8, '0');
            const decompressedCrc = result.testDecompressedData ?
                '0x' + Utils.calculateCrc32(result.testDecompressedData).toString(16).toUpperCase().padStart(8, '0') : 'N/A';

            const info = this.codecConfig.formats[result.codecName];
            const extensionLabel = getFileExtension(result.codecName).toUpperCase();
            const validationClass = (result.compressionSuccess && result.decompressionSuccess)
                ? 'validation-message success'
                : 'validation-message error';

            resultBox.innerHTML = `
                <h3 title="${info.description}">${info.name}</h3>
                <div class="codec-info">
                    <p>BY ${info.author.toUpperCase()} (${info.year})</p>
                </div>
                <div class="status-info">
                    <p>COMPRESSED SIZE: <span>${Utils.formatFileSize(compressedSize)}</span> (${compressedSize} bytes)</p>
                    <p>COMPRESSION RATIO: <span>${result.ratio.toFixed(2)}%</span></p>
                    <p>COMPRESS TIME: <span class="text-accent-cyan">${result.compressionTime.toFixed(2)} ms</span></p>
                    <p>DECOMPRESS TIME: <span class="text-accent-cyan">${result.decompressionTime.toFixed(2)} ms</span></p>
                    <p>ORIGINAL CRC-32: <span>${originalCrc}</span></p>
                    <p>DECOMPRESSED CRC-32: <span>${decompressedCrc}</span></p>
                    <p class="${validationClass}">${validationMessage}</p>
                </div>
                <pre>${Utils.arrayToHex(result.compressedData)}</pre>
                ${result.compressionSuccess ?
                    `<button class="action-button download-btn" data-codec="${result.codecName}"><span>DOWNLOAD ${extensionLabel}</span></button>` :
                    `<button class="action-button" disabled><span>DOWNLOAD (FAILED)</span></button>`}
            `;

            container.appendChild(resultBox);

            if (result.compressionSuccess) {
                resultBox.querySelector('.download-btn').addEventListener('click', (e) => {
                    const button = e.currentTarget;
                    const codec = button.dataset.codec;
                    const extension = getFileExtension(codec);
                    const filename = `${this.originalFileName}_${codec}${extension}`;
                    Utils.downloadBlob(result.compressedData, filename);
                    this.showStatus(`Downloaded: ${filename}`, 'success');
                });
            }
        });

        const remaining = Math.max(0, total - this.allCompressionResults.length);
        for (let i = 0; i < remaining; i++) {
            container.insertAdjacentHTML('beforeend', `
                <div class="result-box skeleton-card">
                    <div class="skeleton-block skeleton-title"></div>
                    <div class="skeleton-block skeleton-meta"></div>
                    <div class="skeleton-block skeleton-meta half"></div>
                    <div class="skeleton-block skeleton-text"></div>
                    <div class="skeleton-block skeleton-text"></div>
                    <div class="skeleton-block skeleton-text short"></div>
                    <div class="skeleton-block skeleton-button"></div>
                </div>
            `);
        }

        if (total > 0) {
            section.classList.remove('hidden');
        } else {
            section.classList.add('hidden');
        }
    }

    clearStatusHideTimer() {
        if (this.statusHideTimer) {
            clearTimeout(this.statusHideTimer);
            this.statusHideTimer = null;
        }
    }

    scheduleStatusHide() {
        this.clearStatusHideTimer();
        this.statusHideTimer = setTimeout(() => this.hideStatusMessage(), this.statusAutoHideDelay);
    }

    hideStatusMessage(immediate = false) {
        const statusDiv = document.getElementById('statusMessage');
        if (!statusDiv || statusDiv.classList.contains('hidden')) {
            this.clearStatusHideTimer();
            return;
        }

        this.clearStatusHideTimer();

        if (immediate) {
            statusDiv.classList.remove('showing', 'hiding');
            statusDiv.classList.add('hidden');
            return;
        }

        statusDiv.classList.remove('showing');
        statusDiv.classList.add('hiding');

        const onAnimationEnd = () => {
            statusDiv.classList.add('hidden');
            statusDiv.classList.remove('hiding');
        };

        statusDiv.addEventListener('animationend', onAnimationEnd, { once: true });
    }
}

