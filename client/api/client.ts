import type {
  CatalogItem,
  CharacterProfile,
  ScriptTurn,
  Story,
  VoiceCasting,
  VoiceDesignCandidate,
  VoiceEntry,
} from '../../shared/types';

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
}

export async function writeStoryDraft(payload: WriteStoryDraftPayload): Promise<Story> {
  const res = await fetch('/api/admin/stories/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<Story>(res);
}

export async function directStory(storyId: string): Promise<Story> {
  const res = await fetch(`/api/admin/stories/${encodeURIComponent(storyId)}/direct`, {
    method: 'POST',
  });
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

export async function previewVoiceAudio(params: {
  voiceId?: string;
  description?: string;
  sampleText?: string;
}): Promise<Blob> {
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
  return res.blob();
}

export interface CreateCustomVoicePayload {
  label: string;
  description: string;
  languageCode?: string;
  tags?: string[];
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
}

export async function synthesizeStoryAudio(
  storyId: string,
  payload: SynthesizeStoryAudioPayload
): Promise<Story> {
  const res = await fetch(`/api/admin/stories/${encodeURIComponent(storyId)}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
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

