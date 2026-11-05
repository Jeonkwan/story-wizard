export const SAMPLE_RATE = 24000;
export const CHANNELS = 1;
export const BITS_PER_SAMPLE = 16;
export const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8); // 48,000

export function extractPcmFromWavOrRaw(input: Buffer): Buffer {
  if (
    input.length >= 44 &&
    input.subarray(0, 4).toString('ascii') === 'RIFF' &&
    input.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    // Walk RIFF chunks to find 'data' chunk offset safely (handles optional LIST/JUNK chunks)
    let offset = 12;
    while (offset + 8 <= input.length) {
      const chunkId = input.subarray(offset, offset + 4).toString('ascii');
      const chunkSize = input.readUInt32LE(offset + 4);
      const dataStart = offset + 8;
      if (chunkId === 'data') {
        const raw = input.subarray(dataStart, Math.min(dataStart + chunkSize, input.length));
        const evenLen = raw.length - (raw.length % 2);
        return raw.subarray(0, evenLen);
      }
      offset = dataStart + chunkSize + (chunkSize % 2); // word-aligned
    }
  }
  const evenLen = input.length - (input.length % 2);
  return input.subarray(0, evenLen); // Already raw PCM (enforce 2-byte sample alignment)
}

export function createSilencePcm(durationMs: number): Buffer {
  const numSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  return Buffer.alloc(numSamples * 2, 0); // 16-bit mono = 2 bytes/sample
}

export function wrapPcmAsWav(pcm: Buffer): { wav: Buffer; durationSec: number } {
  // Enforce 2-byte sample alignment so odd-length buffers never shift 16-bit sample alignment
  const evenLen = pcm.length - (pcm.length % 2);
  const alignedPcm = evenLen === pcm.length ? pcm : pcm.subarray(0, evenLen);
  const header = Buffer.alloc(44);
  const dataSize = alignedPcm.length;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);                              // PCM fmt chunk size
  header.writeUInt16LE(1, 20);                               // AudioFormat = 1 (PCM)
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(CHANNELS * (BITS_PER_SAMPLE / 8), 32);// BlockAlign = 2
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return {
    wav: Buffer.concat([header, alignedPcm]),
    durationSec: Math.max(1, Math.round(dataSize / BYTES_PER_SECOND)),
  };
}
