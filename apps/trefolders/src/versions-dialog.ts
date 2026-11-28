export interface VersionRow {
  label: string;
  when: string;
  current: boolean;
}

/**
 * Drive's "Manage versions" for one file: newest first, each with Download, older ones with Restore.
 * Self-contained modal; callbacks do the work. Escape or Close dismisses.
 */
export function showVersions(
  doc: Document,
  name: string,
  rows: VersionRow[] | null,
  actions: { download(index: number): Promise<void>; restore(index: number): Promise<void> },
  loadError = "",
): void {
  doc.querySelector("[data-testid=versions-dialog]")?.remove();
  const back = doc.createElement("div");
  back.className = "backdrop";
  back.dataset.testid = "versions-dialog";
  const list = rows === null
    ? `<li data-testid="versions-loading"><span class="spinner" aria-hidden="true"></span> Loading versions…</li>`
    : loadError
    ? ""
    : rows.length
    ? rows
        .map(
          (row, index) => `<li class="version-row" data-testid="version-row">
        <span class="version-label"><strong>${esc(row.label)}</strong>${row.current ? ' <span class="badge">Current version</span>' : ""}<br><small>${esc(row.when)}</small></span>
        <span class="version-actions">
          <button type="button" data-v="download" data-i="${index}">Download</button>
          ${row.current ? "" : `<button type="button" data-v="restore" data-i="${index}">Restore</button>`}
        </span></li>`,
        )
        .join("")
    : `<li>No saved versions yet. Versions appear after a change is saved to Filecoin.</li>`;
  back.innerHTML = `<div class="dialog versions" role="dialog" aria-modal="true" aria-labelledby="mv-title">
    <h2 id="mv-title">Manage versions</h2>
    <p class="note">“${esc(name)}” · older versions stay readable while their pieces are still stored.</p>
    <ul class="version-list">${list}</ul>
    <p class="error" data-testid="versions-error" role="alert"${loadError ? "" : " hidden"}>${esc(loadError)}</p>
    <div class="dialog-actions"><button type="button" class="primary" data-v="close">Close</button></div>
  </div>`;
  const close = () => {
    back.remove();
    doc.removeEventListener("keydown", onKey, true);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };
  back.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-v]");
    if (!button) return;
    if (button.dataset.v === "close") return close();
    const index = Number(button.dataset.i);
    const err = back.querySelector<HTMLElement>("[data-testid=versions-error]")!;
    button.disabled = true;
    const run = button.dataset.v === "restore" ? actions.restore(index).then(close) : actions.download(index);
    void run
      .catch((error: unknown) => {
        err.hidden = false;
        err.textContent = `Couldn't read that version (${error instanceof Error ? error.message : String(error)}). Its piece may have been removed from storage.`;
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  doc.addEventListener("keydown", onKey, true);
  doc.body.append(back);
  back.querySelector<HTMLButtonElement>("[data-v=close]")?.focus();
}

function esc(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}
