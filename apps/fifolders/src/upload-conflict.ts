export type UploadChoice = "replace" | "keep" | "cancel";

/**
 * Drive's "Upload options" dialog for same-name uploads: Replace existing file (it becomes a new version)
 * or Keep all items (the upload gets a "(1)" name). Self-contained modal so it works mid-upload.
 */
export function askUploadConflict(doc: Document, count: number, name: string): Promise<UploadChoice> {
  return new Promise((resolve) => {
    const back = doc.createElement("div");
    back.className = "backdrop";
    back.dataset.testid = "upload-conflict";
    const what = count === 1 ? (name ? `“${escape(name)}” already exists in this location.` : "One item already exists in this location.") : `${count} items already exist in this location.`;
    back.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="uc-title">
      <h2 id="uc-title">Upload options</h2>
      <p>${what} Do you want to replace the existing ${count === 1 ? "item" : "items"} with a new version or keep both?</p>
      <label class="check"><input type="radio" name="uc" value="replace" checked /> Replace existing ${count === 1 ? "file" : "files"}</label>
      <label class="check"><input type="radio" name="uc" value="keep" /> Keep all items</label>
      <div class="dialog-actions"><button type="button" data-uc="cancel">Cancel</button><button type="button" class="primary" data-uc="upload" data-testid="upload-conflict-ok">Upload</button></div>
    </div>`;
    const done = (choice: UploadChoice) => {
      back.remove();
      doc.removeEventListener("keydown", onKey, true);
      resolve(choice);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        done("cancel");
      }
    };
    back.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-uc]");
      if (!button) return;
      if (button.dataset.uc === "cancel") return done("cancel");
      const picked = back.querySelector<HTMLInputElement>("input[name=uc]:checked")?.value;
      done(picked === "keep" ? "keep" : "replace");
    });
    doc.addEventListener("keydown", onKey, true);
    doc.body.append(back);
    back.querySelector<HTMLButtonElement>("[data-uc=upload]")?.focus();
  });
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}
