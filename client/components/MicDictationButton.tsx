import React, { useEffect, useRef, useState } from 'react';
import { transcribeAudioBlob } from '../api/client';

export type DictationContextHint = 'story_prompt' | 'voice_prompt' | 'script_dialogue';

export interface MicDictationButtonProps {
  onTranscript: (text: string) => void;
  contextHint?: DictationContextHint;
  compact?: boolean;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}

export function appendWithSmartSpace(current: string, addition: string): string {
  const trimmed = addition.trim();
  if (!trimmed) return current;
  if (!current || !current.trim()) return trimmed;
  const endsWithWhitespace = /\s$/.test(current);
  return `${current}${endsWithWhitespace ? '' : ' '}${trimmed}`;
}

export function getSupportedAudioMimeType(): string | undefined {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return undefined;
  }
  if (typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }
  const candidateMimeTypes = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg',
  ];
  for (const candidate of candidateMimeTypes) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export const MAX_RECORDING_SECONDS = 120;

function formatElapsedTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function MicDictationButton({
  onTranscript,
  contextHint,
  compact = false,
  disabled = false,
  className = '',
  style,
  title,
}: MicDictationButtonProps): React.JSX.Element {
  const [status, setStatus] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const negotiatedMimeTypeRef = useRef<string | undefined>(undefined);

  // Helper to ensure all active audio tracks are completely terminated
  const cleanupStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore errors stopping tracks
        }
      });
      streamRef.current = null;
    }
  };

  const cleanupTimer = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  };

  // Critical Invariant: Always release microphone hardware tracks on component unmount!
  useEffect(() => {
    return () => {
      cleanupTimer();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // Ignore unmount stop error
        }
      }
      cleanupStream();
    };
  }, []);

  const stopRecording = () => {
    cleanupTimer();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Fallback cleanup if stop throws
        cleanupStream();
        setStatus('idle');
      }
    } else {
      cleanupStream();
      setStatus('idle');
    }
  };

  const startRecording = async () => {
    setErrorMessage(null);

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function' ||
      typeof MediaRecorder === 'undefined'
    ) {
      setErrorMessage('Microphone recording is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const chosenMime = getSupportedAudioMimeType();
      negotiatedMimeTypeRef.current = chosenMime;

      const recorder = chosenMime
        ? new MediaRecorder(stream, { mimeType: chosenMime })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onerror = () => {
        cleanupTimer();
        cleanupStream();
        setErrorMessage('An error occurred during microphone recording.');
        setStatus('idle');
      };

      recorder.onstop = async () => {
        cleanupStream();
        const recordedChunks = chunksRef.current;
        const mimeType = negotiatedMimeTypeRef.current || 'audio/webm';

        if (recordedChunks.length === 0) {
          setStatus('idle');
          return;
        }

        const audioBlob = new Blob(recordedChunks, { type: mimeType });
        if (audioBlob.size === 0) {
          setStatus('idle');
          return;
        }

        setStatus('transcribing');
        try {
          const transcript = await transcribeAudioBlob(audioBlob, contextHint);
          if (transcript && transcript.trim()) {
            onTranscript(transcript.trim());
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Transcription failed';
          setErrorMessage(msg);
        } finally {
          setStatus('idle');
          setElapsedSeconds(0);
        }
      };

      recorder.start(500); // 500ms time slices
      setStatus('recording');
      setElapsedSeconds(0);

      // Start live elapsed timer with 120s auto-stop
      const startTime = Date.now();
      timerIntervalRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        setElapsedSeconds(elapsed);
        if (elapsed >= MAX_RECORDING_SECONDS) {
          stopRecording();
        }
      }, 1000);
    } catch (err: unknown) {
      cleanupStream();
      cleanupTimer();
      setStatus('idle');
      const errName = (err as { name?: string })?.name;
      if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
        setErrorMessage('Microphone access was denied. Please allow microphone permissions.');
      } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
        setErrorMessage('No microphone device found on this system.');
      } else {
        const msg = err instanceof Error ? err.message : 'Could not start microphone recording.';
        setErrorMessage(msg);
      }
    }
  };

  if (status === 'recording') {
    return (
      <div
        className={`mic-recording-container ${className}`.trim()}
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', ...style }}
      >
        <span
          className="mic-pulse-dot"
          aria-hidden="true"
        />
        <span
          className="mic-timer"
          role="timer"
          aria-label={`Recording: ${formatElapsedTimer(elapsedSeconds)}`}
        >
          {formatElapsedTimer(elapsedSeconds)}
        </span>
        <button
          type="button"
          className="btn-tactile btn-tactile-primary mic-btn mic-btn-stop"
          onClick={stopRecording}
          aria-label="Stop recording"
        >
          ⏹ Done
        </button>
      </div>
    );
  }

  if (status === 'transcribing') {
    return (
      <button
        type="button"
        className={`btn-tactile mic-btn mic-btn-transcribing ${className}`.trim()}
        style={style}
        disabled
        aria-label="Transcribing audio..."
      >
        ⏳ Transcribing...
      </button>
    );
  }

  return (
    <div
      className={`mic-idle-wrapper ${className}`.trim()}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', position: 'relative', ...style }}
    >
      <button
        type="button"
        className="btn-tactile mic-btn mic-btn-idle"
        onClick={startRecording}
        disabled={disabled}
        title={title || 'Voice dictation'}
        aria-label={title || (compact ? 'Voice dictation' : 'Start voice dictation')}
      >
        {compact ? '🎤' : '🎤 Dictate'}
      </button>

      {errorMessage && (
        <span
          className="mic-error-badge"
          role="alert"
          onClick={() => setErrorMessage(null)}
          title="Click to dismiss error"
        >
          ⚠️ {errorMessage}
        </span>
      )}
    </div>
  );
}
