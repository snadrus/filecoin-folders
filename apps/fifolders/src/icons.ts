/** Original FiFolders mark. A folder with a Filecoin-blue tab and disc. Not the Filecoin logo. */
export function logoSvg(size = 32): string {
  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 32 32" role="img" aria-label="FiFolders">
    <path fill="#3c4043" d="M3 11.5h9.2l2.2 2.3H29V27H3z"/>
    <path fill="#0090FF" d="M3 8h10.2l2 2.2H3z"/>
    <circle cx="22.5" cy="20.5" r="4.2" fill="#0090FF"/>
  </svg>`;
}

/** Original FiPen mark. A fountain-pen nib over a folded-corner page in #0090FF. */
export function felarumiSvg(): string {
  return `<svg class="fel-icon" viewBox="0 0 32 32" aria-hidden="true">
    <path fill="#0090FF" d="M6 4h13l7 7v17H6z"/>
    <path fill="#D6EBFF" d="M19 4v7h7z"/>
    <path fill="#fff" d="M16 7.5c-3.4 4.2-4.6 8-4.6 11.2 0 2.55 2.05 4.6 4.6 4.6s4.6-2.05 4.6-4.6c0-3.2-1.2-7-4.6-11.2z"/>
    <path fill="#0090FF" d="M15.25 12.2h1.5V20h-1.5z"/>
    <circle cx="16" cy="14.1" r="1.15" fill="#0090FF"/>
  </svg>`;
}

/** Original FiGrid mark. A folded-corner page in green with a 3 by 3 grid. */
export function felanumioSvg(): string {
  return `<svg class="fel-icon" viewBox="0 0 32 32" aria-hidden="true">
    <path fill="#178F4B" d="M6 4h13l7 7v17H6z"/>
    <path fill="#D9F5E5" d="M19 4v7h7z"/>
    <g fill="#fff">
      <rect x="9" y="13" width="3.6" height="3.6"/>
      <rect x="13.6" y="13" width="3.6" height="3.6"/>
      <rect x="18.2" y="13" width="3.6" height="3.6"/>
      <rect x="9" y="17.6" width="3.6" height="3.6"/>
      <rect x="13.6" y="17.6" width="3.6" height="3.6"/>
      <rect x="18.2" y="17.6" width="3.6" height="3.6"/>
      <rect x="9" y="22.2" width="3.6" height="3.6"/>
      <rect x="13.6" y="22.2" width="3.6" height="3.6"/>
      <rect x="18.2" y="22.2" width="3.6" height="3.6"/>
    </g>
  </svg>`;
}
