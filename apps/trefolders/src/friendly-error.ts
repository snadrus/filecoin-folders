/**
 * Raw library errors (viem's "HTTP request failed. URL: … Request body: … Version: viem@…") are unreadable.
 * Turn network failures into one plain sentence; leave every other message unchanged.
 */
export function friendlyError(message: string): string {
  if (!message) return message;
  const network = /HTTP request failed|Failed to fetch|fetch failed|NetworkError|ERR_INTERNET_DISCONNECTED|The request took too long|TimeoutError|Load failed/i.test(message);
  if (!network) return message;
  const host = /URL:\s*https?:\/\/([^/\s]+)/.exec(message)?.[1];
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return offline
    ? "You're offline. Reconnect to the internet, then try again."
    : `Can't reach the Filecoin network${host ? ` (${host})` : ""}. Check your connection, then try again.`;
}
