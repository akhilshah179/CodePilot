export interface Note {
  id: string;
  title: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'include', ...init });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  notes: () => request<{ notes: Note[] }>('/api/notes'),
  createNote: (title: string) => request<Note>('/api/notes', json({ title })),
  eventsUrl: (id: string) => `/api/notes/${id}/events`,
};
