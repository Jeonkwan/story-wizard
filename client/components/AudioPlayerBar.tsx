import React, { useEffect, useRef, useState } from 'react';
import type { AudioVersion, Story } from '../../shared/types';

export interface AudioPlayerBarProps {
  story: Story;
  activeVersion: AudioVersion;
  onVersionChange: (version: AudioVersion) => void;
}

export const PLAYBACK_SPEEDS = [0.8, 0.9, 1.0, 1.1, 1.25] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export function formatPlaybackSpeed(speed: number): string {
  if (speed === 1.25) return '1.25x';
  return `${speed.toFixed(1)}x`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '00:00';
  }
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function AudioPlayerBar({
  story,
  activeVersion,
  onVersionChange,
}: AudioPlayerBarProps): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number>(activeVersion.duration_sec || 0);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);

  // Reset playback and sync duration when version changes
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setCurrentTime(0);
    setDuration(activeVersion.duration_sec || 0);
    setIsPlaying(false);
  }, [activeVersion.version_id, activeVersion.duration_sec]);

  // Keep audio playbackRate in sync without resetting playback position
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.defaultPlaybackRate = playbackRate;
      audioRef.current.playbackRate = playbackRate;
    }
  }, [activeVersion.version_id, playbackRate]);

  // Handle Play/Pause
  const togglePlayPause = async () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      try {
        await audio.play();
      } catch (err) {
        // Autoplay policy or abort in tests
        console.warn('Audio play request failed or interrupted:', err);
      }
    }
  };

  // Handle Seeking
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const targetTime = parseFloat(e.target.value);
    setCurrentTime(targetTime);
    if (audioRef.current) {
      audioRef.current.currentTime = targetTime;
    }
  };

  // Handle Speed Cycling: [0.8x, 0.9x, 1.0x, 1.1x, 1.25x]
  const cycleSpeed = () => {
    const currentIndex = PLAYBACK_SPEEDS.indexOf(playbackRate as PlaybackSpeed);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % PLAYBACK_SPEEDS.length;
    const nextRate = PLAYBACK_SPEEDS[nextIndex];
    setPlaybackRate(nextRate);
    if (audioRef.current) {
      audioRef.current.defaultPlaybackRate = nextRate;
      audioRef.current.playbackRate = nextRate;
    }
  };

  // Audio element event listeners
  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.defaultPlaybackRate = playbackRate;
      audio.playbackRate = playbackRate;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const effectiveDuration =
    Number.isFinite(duration) && duration > 0 ? duration : (activeVersion.duration_sec || 0);

  return (
    <div className="docked-audio-bar audio-player-dock" role="region" aria-label="Audio Player">
      {/* Underlying HTML5 Audio element */}
      <audio
        ref={audioRef}
        preload="metadata"
        src={activeVersion.audio_url}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={handleEnded}
      />

      <div className="docked-audio-content">
        <div className="player-scrub-section">
          <input
            type="range"
            className="player-scrub-bar"
            aria-label="Audio scrub bar"
            min="0"
            max={effectiveDuration > 0 ? effectiveDuration : 1}
            step="0.1"
            value={currentTime}
            onChange={handleSeek}
          />

          <span className="player-timecode">
            {formatTime(currentTime)} / {formatTime(effectiveDuration)}
          </span>
        </div>

        <div className="docked-audio-main-row">
          <div className="player-track-info">
            <span className="player-track-title">{story.title}</span>
            <span className="player-track-version">{activeVersion.label}</span>
          </div>

          <div className="player-main-controls">
            <button
              type="button"
              className="btn-tactile btn-tactile-primary"
              onClick={togglePlayPause}
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? '⏸ Pause' : '▶ Play'}
            </button>

            <button
              type="button"
              className="btn-tactile player-speed-btn"
              onClick={cycleSpeed}
              aria-label={`Playback speed ${formatPlaybackSpeed(playbackRate)}`}
              title={`Playback speed ${formatPlaybackSpeed(playbackRate)}`}
              style={{ minWidth: '60px' }}
            >
              {formatPlaybackSpeed(playbackRate)}
            </button>
          </div>

          <div className="player-meta-controls">
            <label htmlFor="audio-version-select" style={{ display: 'none' }}>
              Audio Version
            </label>
            <select
              id="audio-version-select"
              className="select-tactile version-select"
              aria-label="Audio Version"
              value={activeVersion.version_id}
              onChange={(e) => {
                const selected = story.audio_versions.find((v) => v.version_id === e.target.value);
                if (selected) {
                  onVersionChange(selected);
                }
              }}
            >
              {story.audio_versions.map((ver) => (
                <option key={ver.version_id} value={ver.version_id}>
                  {ver.label} {ver.is_default ? '(Default)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
