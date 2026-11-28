const PREVIEW = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp|pdf|txt|md|markdown|json|html?|mp3|wav|ogg|oga|opus|m4a|aac|flac|mp4|webm)$/i;

export function gatewayPreviewLink(cid: string, name = ""): string {
  const base = `https://ipfs.io/ipfs/${cid}`;
  if (!name) return base;
  return `${base}?filename=${encodeURIComponent(name)}`;
}

export function canPreviewName(name: string, cid?: string, importedCar = false): boolean {
  return Boolean(cid) && !importedCar && PREVIEW.test(name);
}

export interface ShareFile {
  name: string;
  cid?: string;
  pieceCid?: string;
  importedCar?: boolean;
  serviceURLs?: string[];
  removalScheduled?: boolean;
  uploadComplete?: boolean;
  encrypted?: boolean;
}

/** Ordinary files share an IPFS gateway URL. Imported CARs share the stored piece so every original byte is preserved. */
export function fileShareLink(file: ShareFile): string | undefined {
  if (file.removalScheduled || file.uploadComplete === false || file.encrypted) return undefined;
  if (!file.importedCar) {
    if (!file.cid) return undefined;
    return gatewayPreviewLink(file.cid, file.name);
  }
  if (!file.pieceCid) return undefined;
  for (const serviceURL of file.serviceURLs ?? []) {
    try {
      const url = new URL(serviceURL);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      return new URL(`/piece/${encodeURIComponent(file.pieceCid)}`, url).href;
    } catch {
      // Try the next copy.
    }
  }
  return undefined;
}
