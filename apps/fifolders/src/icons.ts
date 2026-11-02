/** Original FiFolders mark. A folder with a Filecoin-blue tab and disc. Not the Filecoin logo. */
export function logoSvg(size = 32): string {
  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 32 32" role="img" aria-label="FiFolders">
    <path fill="#3c4043" d="M3 11.5h9.2l2.2 2.3H29V27H3z"/>
    <path fill="#0090FF" d="M3 8h10.2l2 2.2H3z"/>
    <circle cx="22.5" cy="20.5" r="4.2" fill="#0090FF"/>
  </svg>`;
}

/** Original mark for .felarumi files. A blue page with a folded corner. */
export function felarumiSvg(): string {
  return `<svg class="fel-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#0090FF" d="M6 2h8l4 4v16H6z"/>
    <path fill="#7cc4ff" d="M14 2v4h4z"/>
    <path fill="#fff" d="M8 12h8v1.6H8zm0 3.2h6v1.6H8z"/>
  </svg>`;
}

/** Original mark for .felanumio files. A blue diamond on a page. */
export function felanumioSvg(): string {
  return `<svg class="fel-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#16324f" d="M6 2h12v20H6z"/>
    <path fill="#0090FF" d="M12 7l4 5-4 5-4-5z"/>
  </svg>`;
}
