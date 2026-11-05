import type { CatalogItem, Story } from '../../shared/types';

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

export async function fetchCatalog(includeDrafts = false): Promise<CatalogItem[]> {
  const url = includeDrafts ? '/api/catalog?includeDrafts=true' : '/api/catalog';
  const res = await fetch(url);
  return handleResponse<CatalogItem[]>(res);
}

export async function fetchStory(id: string): Promise<Story> {
  const res = await fetch(`/api/stories/${encodeURIComponent(id)}`);
  return handleResponse<Story>(res);
}
