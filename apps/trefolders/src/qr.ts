import { renderSVG } from "uqr";

/** SVG QR of a share URL. Uses the current text color so light and dark mode both read. */
export function qrSvg(text: string): string {
  return renderSVG(text, { ecc: "M", border: 2, pixelSize: 4, blackColor: "currentColor", whiteColor: "transparent" });
}
