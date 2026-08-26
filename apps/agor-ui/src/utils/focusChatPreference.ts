// v2 deliberately ignores the legacy key. The chat-workspace route used to
// write the old key automatically, leaving every ordinary session stuck in
// focus mode after the user navigated away.
const FOCUS_CHAT_STORAGE_KEY = 'agor.session.focus-chat.v2';
const FOCUS_CHAT_EVENT = 'agor:focus-chat-preference';

export function readFocusChatPreference(): boolean {
  try {
    return localStorage.getItem(FOCUS_CHAT_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeFocusChatPreference(enabled: boolean): void {
  try {
    localStorage.setItem(FOCUS_CHAT_STORAGE_KEY, String(enabled));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  window.dispatchEvent(new CustomEvent<boolean>(FOCUS_CHAT_EVENT, { detail: enabled }));
}

export function subscribeToFocusChatPreference(listener: (enabled: boolean) => void): () => void {
  const handlePreference = (event: Event) => {
    listener((event as CustomEvent<boolean>).detail);
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === FOCUS_CHAT_STORAGE_KEY) listener(event.newValue === 'true');
  };
  window.addEventListener(FOCUS_CHAT_EVENT, handlePreference);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(FOCUS_CHAT_EVENT, handlePreference);
    window.removeEventListener('storage', handleStorage);
  };
}
