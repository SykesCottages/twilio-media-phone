/**
 * Audio Worklet Processor for encoding audio to µ-law format
 * This processor handles incoming audio data, encodes it to µ-law format,
 * and outputs the encoded audio data.
 */
class ULawProcessor extends AudioWorkletProcessor {
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const channelData = input[0];
        const ulaw = new Uint8Array(channelData.length);

        for (let i = 0; i < channelData.length; i++) {
            const sample = channelData[i] * 32767;
            ulaw[i] = this.linearToUlaw(sample);
        }

        this.port.postMessage(ulaw);
        return true;
    }

    linearToUlaw(sample) {
        const BIAS = 0x84;
        const CLIP = 32635;

        let sign = (sample < 0) ? 0x80 : 0;
        sample = Math.abs(sample);
        if (sample > CLIP) sample = CLIP;
        sample += BIAS;

        let exponent = 7;
        for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
            exponent--;
        }

        let mantissa = (sample >> (exponent + 3)) & 0x0F;
        return ~(sign | (exponent << 4) | mantissa) & 0xFF;
    }
}

registerProcessor('ulaw-processor', ULawProcessor);
