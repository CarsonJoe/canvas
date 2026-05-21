const STORAGE_KEY = 'cogniboom-canvas-openai-key';
const CHANGE_EVENT = 'cogniboom-canvas-openai-key-change';
const REQUEST_EVENT = 'cogniboom-canvas-openai-key-request';

export function getOpenAiApiKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

export function hasOpenAiApiKey(): boolean {
  return getOpenAiApiKey().length > 0;
}

export function setOpenAiApiKey(key: string): void {
  const trimmed = key.trim();
  try {
    if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore blocked storage. Generation will fail the next key check.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function clearOpenAiApiKey(): void {
  setOpenAiApiKey('');
}

export function listenForOpenAiApiKeyChanges(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener('storage', callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener('storage', callback);
  };
}

export function requestOpenAiApiKey(): void {
  window.dispatchEvent(new Event(REQUEST_EVENT));
}

export function listenForOpenAiApiKeyRequests(callback: () => void): () => void {
  window.addEventListener(REQUEST_EVENT, callback);
  return () => window.removeEventListener(REQUEST_EVENT, callback);
}
