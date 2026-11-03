/** Step-by-step load progress ("Finding your folders…") so the onboarding/session load never waits silently. */
type Listener = (text: string) => void;
const listeners = new Set<Listener>();

export function reportLoadStep(text: string): void {
  for (const listener of listeners) listener(text);
}

export function onLoadStep(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
