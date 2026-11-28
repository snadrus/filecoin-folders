/** Fragment-only share links for files in a private volume. */
import type { Storage, Volume } from "fil-folders";
import { Keysmith, encodeShareFragment, makeFileShare, readLabels, type OpenedCredential } from "fil-folders/private";

export function sharePageBase(base: string): URL {
  try {
    const url = new URL("share/", base);
    if (/^https?:$/.test(url.protocol)) return url;
  } catch {
    /* fall through */
  }
  return new URL("https://fifolders.scionbase.ai/share/");
}

export async function makeVolumeFileShare(input: {
  volume: Volume;
  credential: OpenedCredential;
  labels: Map<string, Keysmith.PieceLabels>;
  storage: Storage;
  providers: string[];
  chain: "calibration" | "mainnet";
  chainId: number;
  path: string;
  base: string;
}): Promise<string> {
  const info = await input.volume.fileShareInfo(input.path);
  let labels = input.labels.get(info.piece);
  if (!labels) {
    // Read once through the gate; the private storage records the labels.
    await input.storage.get(info.piece);
    labels = input.labels.get(info.piece);
  }
  if (!labels) throw new Error("This file's piece is not private, so it has no private link.");
  const name = input.path.split("/").filter(Boolean).at(-1) ?? "file";
  const share = await makeFileShare({
    issuer: { kind: "delegate", signer: input.credential.bearer, chain: input.credential.chain, parentKey: input.credential.groupKey },
    ref: input.credential.ref,
    chainId: input.chainId,
    network: input.chain,
    providers: input.providers,
    piece: info.piece,
    labels,
    file: { cid: info.contentCid, iv: info.iv, key: info.fileKey, name, size: info.size, ...(info.mime ? { mime: info.mime } : {}) },
  });
  const editor = /\.(fipen|trepen|felarumi)$/i.test(name) ? "trepen/" : /\.(figrid|tregrid|felanumio)$/i.test(name) ? "tregrid/" : "";
  if (editor) {
    // TrePen / TreGrid open the saved version straight from the fragment (`fp=`), next to any room secret.
    const url = new URL("../" + editor, sharePageBase(input.base));
    url.searchParams.set("name", name);
    url.hash = "fp=" + encodeURIComponent(encodeShareFragment(share));
    return url.href;
  }
  const url = sharePageBase(input.base);
  url.hash = encodeShareFragment(share);
  return url.href;
}

export { readLabels };
