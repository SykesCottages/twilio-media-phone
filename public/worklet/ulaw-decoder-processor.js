/**
 * Audio Worklet Processor for decoding µ-law audio
 * This processor handles incoming µ-law audio data, decodes it to PCM format,
 * and outputs the decoded audio data.
 */
class ULawDecoderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.initMuLawTable();
        this.port.onmessage = this.handleMessage.bind(this);
        
        // Queue of buffers to process in order
        this.bufferQueue = [];
        
        // Current buffer being processed
        this.currentBuffer = null;
        this.bufferPosition = 0;
        this.currentMark = null;
        
        // Status tracking
        this.isActive = false;
        this.sequenceNumber = 0;
    }
    
    initMuLawTable() {
        this.muLawTable = new Int16Array(256);
        for (let i = 0; i < 256; i++) {
            let val = ~i;
            let t = ((val & 0x0F) << 3) + 0x84;
            t <<= (val & 0x70) >> 4;
            this.muLawTable[i] = val & 0x80 ? 0x84 - t : t - 0x84;
        }
    }
    
    handleMessage(event) {
        if (event.data.type === 'decode') {
            const ulawData = event.data.ulawData;
            const markName = event.data.markName || null;
            const sequenceNumber = event.data.sequenceNumber || this.sequenceNumber++;
            
            this.bufferQueue.push({
                data: ulawData,
                markName: markName,
                sequenceNumber: sequenceNumber
            });
            
            this.bufferQueue.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
            this.port.postMessage({
                type: 'bufferQueued',
                bufferLength: ulawData.length,
                queueLength: this.bufferQueue.length
            });
        } else if (event.data.type === 'clear') {
            this.bufferQueue = [];
            this.currentBuffer = null;
            this.currentMark = null;
            this.bufferPosition = 0;
            
            this.port.postMessage({
                type: 'cleared'
            });
        }
    }
    
    decodeMuLaw(muLawByte) {
        return this.muLawTable[muLawByte] / 32768.0;
    }
    
    loadNextBuffer() {
        if (this.bufferQueue.length > 0) {
            const nextBuffer = this.bufferQueue.shift();
            this.currentBuffer = nextBuffer.data;
            this.currentMark = nextBuffer.markName;
            this.bufferPosition = 0;
            this.isActive = true;
            return true;
        }
        return false;
    }
    
    process(inputs, outputs) {
        const output = outputs[0];
        const channel = output[0];
        
        if (!this.currentBuffer || this.bufferPosition >= this.currentBuffer.length) {
            if (this.currentBuffer) {
                // Notify the main thread the buffer has been processed
                const markName = this.currentMark;
                this.port.postMessage({
                    type: 'bufferProcessed',
                    markName: markName
                });
                
                this.currentBuffer = null;
                this.currentMark = null;
            }
            
            if (!this.loadNextBuffer()) {
                // No more buffers, output silence
                for (let i = 0; i < channel.length; i++) {
                    channel[i] = 0;
                }
                this.isActive = false;
                return true;
            }
        }
        
        for (let i = 0; i < channel.length; i++) {
            if (this.bufferPosition < this.currentBuffer.length) {
                // Decode one µ-law byte to a float sample
                channel[i] = this.decodeMuLaw(this.currentBuffer[this.bufferPosition++]);
            } else {
                channel[i] = 0; // Silence for any remaining samples
                break;
            }
        }
        
        return true;
    }
}

// Register our processor
registerProcessor('ulaw-decoder-processor', ULawDecoderProcessor);
