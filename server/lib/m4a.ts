import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLosslessWavUrl } from '../../shared/types.js';

const execFileAsync = promisify(execFile);

/**
 * Function signature for transcoding a WAV audio buffer into an AAC-LC `.m4a` buffer.
 * Injected into `GeminiTtsService` and `createApp` so unit tests can mock FFmpeg if desired.
 */
export type M4aTranscoder = (wavBuffer: Buffer) => Promise<Buffer>;

export { getLosslessWavUrl };

/**
 * Transcodes an uncompressed WAV buffer into an AAC-LC `.m4a` (MP4 audio) buffer
 * with `-movflags +faststart` so the `moov` atom is relocated to byte 0 for instant
 * HTTP 206 Range streaming in web browsers and Apple Podcasts.
 */
export async function transcodeWavToM4a(wavBuffer: Buffer): Promise<Buffer> {
  if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length === 0) {
    throw new Error('Cannot transcode empty WAV buffer to M4A');
  }

  const rand = Math.random().toString(36).slice(2, 10);
  const baseName = `story-wizard-${process.pid}-${Date.now()}-${rand}`;
  const tmpDir = os.tmpdir();
  const tmpWavPath = path.join(tmpDir, `${baseName}.wav`);
  const tmpM4aPath = path.join(tmpDir, `${baseName}.m4a`);

  try {
    await fs.promises.writeFile(tmpWavPath, wavBuffer);

    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'wav',
        '-i',
        tmpWavPath,
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        tmpM4aPath,
      ],
      { maxBuffer: 10 * 1024 * 1024 }
    );

    const m4aBuffer = await fs.promises.readFile(tmpM4aPath);
    if (m4aBuffer.length < 12 || m4aBuffer.subarray(4, 8).toString('ascii') !== 'ftyp') {
      throw new Error('FFmpeg produced invalid or empty M4A output (missing ftyp box)');
    }

    return m4aBuffer;
  } finally {
    await Promise.all([
      fs.promises.unlink(tmpWavPath).catch(() => undefined),
      fs.promises.unlink(tmpM4aPath).catch(() => undefined),
    ]);
  }
}
