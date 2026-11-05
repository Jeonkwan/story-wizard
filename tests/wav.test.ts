import { describe, it, expect } from 'vitest';
import {
  SAMPLE_RATE,
  CHANNELS,
  BITS_PER_SAMPLE,
  BYTES_PER_SECOND,
  wrapPcmAsWav,
  extractPcmFromWavOrRaw,
  createSilencePcm,
} from '../server/lib/wav';

describe('WAV and PCM Utilities (server/lib/wav.ts)', () => {
  it('wrapPcmAsWav outputs a 44-byte RIFF header with 24000 sample rate and exact pcm length', () => {
    const rawPcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const { wav, durationSec } = wrapPcmAsWav(rawPcm);

    expect(wav.length).toBe(44 + rawPcm.length);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(wav.readUInt32LE(24)).toBe(SAMPLE_RATE); // 24000
    expect(wav.readUInt16LE(22)).toBe(CHANNELS); // 1
    expect(wav.readUInt16LE(34)).toBe(BITS_PER_SAMPLE); // 16
    expect(wav.readUInt32LE(28)).toBe(BYTES_PER_SECOND); // 48000
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(rawPcm.length);
    expect(durationSec).toBe(1); // Math.max(1, Math.round(8 / 48000))
  });

  it('extractPcmFromWavOrRaw cleanly strips header from standard wrapped WAV', () => {
    const originalPcm = Buffer.from(new Uint8Array(4800).fill(42));
    const { wav } = wrapPcmAsWav(originalPcm);

    const extracted = extractPcmFromWavOrRaw(wav);
    expect(extracted.length).toBe(originalPcm.length);
    expect(Buffer.compare(extracted, originalPcm)).toBe(0);
  });

  it('extractPcmFromWavOrRaw handles WAV containing extra LIST metadata chunk before data chunk', () => {
    const pcmData = Buffer.from([10, 20, 30, 40, 50, 60]);

    // Build custom RIFF WAV with fmt chunk, LIST chunk, and data chunk
    const fmtChunk = Buffer.alloc(24);
    fmtChunk.write('fmt ', 0, 'ascii');
    fmtChunk.writeUInt32LE(16, 4);
    fmtChunk.writeUInt16LE(1, 8); // PCM
    fmtChunk.writeUInt16LE(1, 10); // mono
    fmtChunk.writeUInt32LE(24000, 12);
    fmtChunk.writeUInt32LE(48000, 16);
    fmtChunk.writeUInt16LE(2, 20);
    fmtChunk.writeUInt16LE(16, 22);

    const listPayload = Buffer.from('INFOtest');
    const listChunk = Buffer.alloc(8 + listPayload.length);
    listChunk.write('LIST', 0, 'ascii');
    listChunk.writeUInt32LE(listPayload.length, 4);
    listPayload.copy(listChunk, 8);

    const dataHeader = Buffer.alloc(8);
    dataHeader.write('data', 0, 'ascii');
    dataHeader.writeUInt32LE(pcmData.length, 4);

    const totalSize = 4 + fmtChunk.length + listChunk.length + dataHeader.length + pcmData.length;
    const riffHeader = Buffer.alloc(12);
    riffHeader.write('RIFF', 0, 'ascii');
    riffHeader.writeUInt32LE(totalSize - 8, 4);
    riffHeader.write('WAVE', 8, 'ascii');

    const fullWavWithList = Buffer.concat([riffHeader, fmtChunk, listChunk, dataHeader, pcmData]);

    const extracted = extractPcmFromWavOrRaw(fullWavWithList);
    expect(extracted.length).toBe(pcmData.length);
    expect(Buffer.compare(extracted, pcmData)).toBe(0);
  });

  it('extractPcmFromWavOrRaw returns raw PCM untouched if no RIFF header present', () => {
    const rawPcm = Buffer.from([100, 101, 102, 103]);
    const extracted = extractPcmFromWavOrRaw(rawPcm);
    expect(Buffer.compare(extracted, rawPcm)).toBe(0);
  });

  it('concatenating two WAV buffers via extractPcmFromWavOrRaw + createSilencePcm + wrapPcmAsWav produces seamless single WAV without mid-stream RIFF', () => {
    // 1 second of audio at 24kHz 16-bit mono = 48,000 bytes
    const pcm1 = Buffer.alloc(48000, 1);
    const pcm2 = Buffer.alloc(48000, 2);

    const wav1 = wrapPcmAsWav(pcm1).wav;
    const wav2 = wrapPcmAsWav(pcm2).wav;

    // 150ms of silence = 0.15 * 24000 * 2 = 7,200 bytes
    const silence150 = createSilencePcm(150);
    expect(silence150.length).toBe(7200);

    const raw1 = extractPcmFromWavOrRaw(wav1);
    const raw2 = extractPcmFromWavOrRaw(wav2);

    const stitchedPcm = Buffer.concat([raw1, silence150, raw2]);
    const expectedPcmLength = 48000 + 7200 + 48000;
    expect(stitchedPcm.length).toBe(expectedPcmLength);

    const result = wrapPcmAsWav(stitchedPcm);
    expect(result.wav.length).toBe(44 + expectedPcmLength);
    expect(result.wav.subarray(0, 4).toString('ascii')).toBe('RIFF');

    // Crucial check: NO embedded "RIFF" bytes after byte 0
    const subBuffer = result.wav.subarray(1);
    expect(subBuffer.indexOf('RIFF')).toBe(-1);

    // Duration: 103,200 / 48,000 = 2.15 seconds -> Math.round is 2
    expect(result.durationSec).toBe(2);
  });
});
