import type {
  CatalogItem,
  CharacterProfile,
  JobProgress,
  ScriptTurn,
  Story,
  StoryAgeRange,
  StoryLength,
  StoryVocabularyLevel,
  StoryPromptMetadata,
  VoiceCasting,
  VoiceDesignCandidate,
  VoiceEntry,
  VoicePace,
} from '../../shared/types';

export type { StoryAgeRange, StoryLength, StoryVocabularyLevel, StoryPromptMetadata };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let errorMessage = `HTTP ${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data && typeof data.error === 'string') {
        errorMessage = data.error;
      }
    } catch {
      // Body not JSON, keep status text
    }
    throw new ApiError(res.status, errorMessage);
  }
  return res.json() as Promise<T>;
}

export interface AdminSession {
  authenticated: boolean;
  email?: string;
  devBypassEnabled: boolean;
  googleClientId?: string;
}

export async function fetchCatalog(includeDrafts = false): Promise<CatalogItem[]> {
  const url = includeDrafts ? '/api/catalog?includeDrafts=true' : '/api/catalog';
  const res = await fetch(url);
  return handleResponse<CatalogItem[]>(res);
}

export async function fetchStory(id: string): Promise<Story> {
  const res = await fetch(`/api/stories/${encodeURIComponent(id)}`);
  return handleResponse<Story>(res);
}

export async function fetchAdminSession(): Promise<AdminSession> {
  const res = await fetch('/api/admin/me');
  return handleResponse<AdminSession>(res);
}

export async function loginWithGoogle(idToken: string): Promise<{ ok: boolean; email: string }> {
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  return handleResponse<{ ok: boolean; email: string }>(res);
}

export async function loginWithDevBypass(): Promise<{ ok: boolean; email: string }> {
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ devBypass: true }),
  });
  return handleResponse<{ ok: boolean; email: string }>(res);
}

export async function logoutAdmin(): Promise<{ ok: boolean }> {
  const res = await fetch('/api/admin/logout', {
    method: 'POST',
  });
  return handleResponse<{ ok: boolean }>(res);
}

export interface AsyncJobOptions {
  async?: boolean;
  onProgress?: (job: JobProgress) => void;
  pollIntervalMs?: number;
}

export async function fetchActiveJobs(storyId?: string): Promise<JobProgress[]> {
  try {
    const url = storyId
      ? `/api/admin/jobs/active?storyId=${encodeURIComponent(storyId)}`
      : '/api/admin/jobs/active';
    const res = await fetch(url);
    if (!res.ok) {
      return [];
    }
    const data = await handleResponse<{ activeJobs: JobProgress[] }>(res);
    return Array.isArray(data?.activeJobs) ? data.activeJobs : [];
  } catch {
    return [];
  }
}

export async function fetchJobStatus(jobId: string): Promise<JobProgress> {
  const res = await fetch(`/api/admin/jobs/${encodeURIComponent(jobId)}`);
  const data = await handleResponse<{ job: JobProgress }>(res);
  return data.job;
}

export async function pollJobUntilComplete(
  jobId: string,
  onProgress?: (job: JobProgress) => void,
  pollIntervalMs = 1500
): Promise<JobProgress> {
  while (true) {
    const job = await fetchJobStatus(jobId);
    if (onProgress) {
      onProgress(job);
    }
    if (job.status === 'completed') {
      return job;
    }
    if (job.status === 'failed') {
      throw new Error(job.error || job.message || `Job ${jobId} failed`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export async function fetchAdminStories(): Promise<CatalogItem[]> {
  const res = await fetch('/api/admin/stories');
  return handleResponse<CatalogItem[]>(res);
}

export interface WriteStoryDraftPayload {
  mode: 'fresh' | 'sequel';
  prompt: string;
  referenceText?: string;
  seriesId?: string;
  previousStoryId?: string;
  ageRange?: StoryAgeRange;
  ageGroup?: StoryAgeRange;
  storyLength?: StoryLength;
  vocabularyLevel?: StoryVocabularyLevel;
  genrePreset?: string;
  autoDirect?: boolean;
  autoSynthesize?: boolean;
  narratorVoiceId?: string;
  avoidCharacterNames?: string[];
  async?: boolean;
  onProgress?: (job: JobProgress) => void;
  pollIntervalMs?: number;
}

export async function writeStoryDraft(
  payload: WriteStoryDraftPayload,
  options?: AsyncJobOptions
): Promise<Story> {
  const isAsync = options?.async ?? payload.async ?? false;
  const onProgress = options?.onProgress ?? payload.onProgress;
  const pollIntervalMs = options?.pollIntervalMs ?? payload.pollIntervalMs;
  const url = isAsync ? '/api/admin/stories/write?async=true' : '/api/admin/stories/write';

  const { async: _a, onProgress: _p, pollIntervalMs: _pi, ...bodyPayload } = payload;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyPayload),
  });

  if (isAsync) {
    const { jobId } = await handleResponse<{ jobId: string; status: string }>(res);
    const completedJob = await pollJobUntilComplete(jobId, onProgress, pollIntervalMs);
    if (!completedJob.result_story_id) {
      throw new Error('Draft job completed without resulting story ID');
    }
    return fetchStory(completedJob.result_story_id);
  }

  return handleResponse<Story>(res);
}

/** Alias for writeStoryDraft */
export const writeStory = writeStoryDraft;

export async function directStory(
  storyId: string,
  options?: AsyncJobOptions
): Promise<Story> {
  const isAsync = options?.async ?? false;
  const url = isAsync
    ? `/api/admin/stories/${encodeURIComponent(storyId)}/direct?async=true`
    : `/api/admin/stories/${encodeURIComponent(storyId)}/direct`;

  const res = await fetch(url, {
    method: 'POST',
  });

  if (isAsync) {
    const { jobId } = await handleResponse<{ jobId: string; status: string }>(res);
    await pollJobUntilComplete(jobId, options?.onProgress, options?.pollIntervalMs);
    return fetchStory(storyId);
  }

  return handleResponse<Story>(res);
}

export interface StoryEditsPayload {
  title: string;
  summary: string;
  tags: string[];
  characters: CharacterProfile[];
  script_turns: ScriptTurn[];
  voice_candidates?: VoiceDesignCandidate[];
}

export async function saveStoryEdits(storyId: string, edits: StoryEditsPayload): Promise<Story> {
  const res = await fetch(`/api/admin/stories/${encodeURIComponent(storyId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(edits),
  });
  return handleResponse<Story>(res);
}

export async function patchStoryStatus(
  storyId: string,
  status: 'draft' | 'published'
): Promise<Story> {
  const res = await fetch(`/api/admin/stories/${encodeURIComponent(storyId)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return handleResponse<Story>(res);
}

export async function deleteStory(storyId: string): Promise<{ ok: boolean; deletedId: string }> {
  const res = await fetch(`/api/admin/stories/${encodeURIComponent(storyId)}`, {
    method: 'DELETE',
  });
  return handleResponse<{ ok: boolean; deletedId: string }>(res);
}

export async function fetchVoices(): Promise<VoiceEntry[]> {
  const res = await fetch('/api/admin/voices');
  return handleResponse<VoiceEntry[]>(res);
}

export interface PreviewVoiceAudioParams {
  voiceId?: string;
  description?: string;
  sampleText?: string;
  pace?: VoicePace;
  draftGeminiVoiceName?: string;
  previousDraftGeminiVoiceName?: string;
  regenerateTake?: boolean;
}

export interface PreviewVoiceAudioResult {
  blob: Blob;
  draftGeminiVoiceName: string | null;
}

export async function previewVoiceAudio(
  params: PreviewVoiceAudioParams
): Promise<PreviewVoiceAudioResult> {
  const res = await fetch('/api/admin/voices/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    let errorMessage = `HTTP ${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data && typeof data.error === 'string') {
        errorMessage = data.error;
      }
    } catch {
      // Body not JSON
    }
    throw new ApiError(res.status, errorMessage);
  }
  const draftGeminiVoiceName = res.headers.get('X-Draft-Voice-Name');
  const blob = await res.blob();
  return { blob, draftGeminiVoiceName };
}

export async function blobToBase64(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        const base64 = result && result.includes(',') ? result.split(',')[1] : (result || '');
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error || new Error('Failed to read blob as base64'));
      reader.readAsDataURL(blob);
    });
  }
  const buffer = await blob.arrayBuffer();
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64');
  }
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export interface CreateCustomVoicePayload {
  label: string;
  description: string;
  languageCode?: string;
  tags?: string[];
  defaultPace?: VoicePace;
  stagedGeminiVoiceName?: string;
  previewAudioBase64?: string;
}

export async function createCustomVoice(payload: CreateCustomVoicePayload): Promise<VoiceEntry> {
  const res = await fetch('/api/admin/voices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<VoiceEntry>(res);
}

export interface SynthesizeStoryAudioPayload {
  casting: VoiceCasting;
  label?: string;
  makeDefault?: boolean;
  async?: boolean;
  onProgress?: (job: JobProgress) => void;
  pollIntervalMs?: number;
}

export async function synthesizeStoryAudio(
  storyId: string,
  payload: SynthesizeStoryAudioPayload,
  options?: AsyncJobOptions
): Promise<Story> {
  const isAsync = options?.async ?? payload.async ?? false;
  const onProgress = options?.onProgress ?? payload.onProgress;
  const pollIntervalMs = options?.pollIntervalMs ?? payload.pollIntervalMs;
  const url = isAsync
    ? `/api/admin/stories/${encodeURIComponent(storyId)}/synthesize?async=true`
    : `/api/admin/stories/${encodeURIComponent(storyId)}/synthesize`;

  const { async: _a, onProgress: _p, pollIntervalMs: _pi, ...bodyPayload } = payload;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyPayload),
  });

  if (isAsync) {
    const { jobId } = await handleResponse<{ jobId: string; status: string }>(res);
    await pollJobUntilComplete(jobId, onProgress, pollIntervalMs);
    return fetchStory(storyId);
  }

  return handleResponse<Story>(res);
}

export async function setDefaultAudioVersion(
  storyId: string,
  versionId: string
): Promise<Story> {
  const res = await fetch(
    `/api/admin/stories/${encodeURIComponent(storyId)}/versions/${encodeURIComponent(versionId)}/default`,
    {
      method: 'PATCH',
    }
  );
  return handleResponse<Story>(res);
}

export async function deleteAudioVersion(
  storyId: string,
  versionId: string
): Promise<Story> {
  const res = await fetch(
    `/api/admin/stories/${encodeURIComponent(storyId)}/versions/${encodeURIComponent(versionId)}`,
    {
      method: 'DELETE',
    }
  );
  return handleResponse<Story>(res);
}

export interface UpdateVoicePatch {
  label?: string;
  description?: string;
  tags?: string[];
  defaultPace?: VoicePace;
  default_pace?: VoicePace;
}

export async function updateVoice(
  voiceId: string,
  patch: UpdateVoicePatch | Partial<VoiceEntry>
): Promise<VoiceEntry> {
  const res = await fetch(`/api/admin/voices/${encodeURIComponent(voiceId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return handleResponse<VoiceEntry>(res);
}

export async function deleteVoice(
  voiceId: string
): Promise<{ ok: boolean; deletedId: string }> {
  const res = await fetch(`/api/admin/voices/${encodeURIComponent(voiceId)}`, {
    method: 'DELETE',
  });
  return handleResponse<{ ok: boolean; deletedId: string }>(res);
}

export async function discardDraftVoice(
  geminiVoiceName: string
): Promise<{ ok: boolean }> {
  const cleanId = geminiVoiceName.trim();
  const res = await fetch(`/api/admin/voices/draft/${encodeURIComponent(cleanId)}`, {
    method: 'DELETE',
  });
  return handleResponse<{ ok: boolean }>(res);
}

export async function transcribeAudioBlob(
  blob: Blob,
  contextHint?: 'story_prompt' | 'voice_prompt' | 'script_dialogue'
): Promise<string> {
  const audioBase64 = await blobToBase64(blob);
  const mimeType = blob.type || 'audio/webm';
  const res = await fetch('/api/admin/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audioBase64,
      mimeType,
      contextHint,
    }),
  });
  const data = await handleResponse<{ text: string }>(res);
  return data.text;
}

