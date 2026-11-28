/**
 * A tab opened before a deploy may ask for a chunk the new deploy removed ("Failed to fetch dynamically imported module").
 * Vite fires `vite:preloadError` for that; reload once (per page, per 30 s) so the fresh HTML and chunk names load.
 */
const KEY = "fifolders:stale-chunk-reload";

export function installStaleChunkReload(win: Window = window): void {
  win.addEventListener("vite:preloadError", (event) => {
    let last = 0;
    try {
      last = Number(win.sessionStorage.getItem(KEY + ":" + win.location.pathname)) || 0;
    } catch {
      // ignore
    }
    if (Date.now() - last < 30_000) return; // already reloaded once; let the error surface
    event.preventDefault();
    try {
      win.sessionStorage.setItem(KEY + ":" + win.location.pathname, String(Date.now()));
    } catch {
      // ignore
    }
    win.location.reload();
  });
}

installStaleChunkReload();
