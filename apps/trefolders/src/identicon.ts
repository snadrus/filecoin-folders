/** Symmetric 5×5 identicon. No network and no extra dependency. */
export function identiconSvg(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "").replace(/[^0-9a-f]/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2) || "0", 16));
  if (!bytes.length) bytes.push(0);
  const hue = (bytes[0] ?? 0) % 360;
  const color = `hsl(${hue} 55% 42%)`;
  let cells = "";
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      const sample = bytes[(y * 3 + x) % bytes.length] ?? 0;
      if (sample % 2 === 0) continue;
      cells += `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`;
      if (x < 2) cells += `<rect x="${4 - x}" y="${y}" width="1" height="1" fill="${color}"/>`;
    }
  }
  return `<svg class="identicon" data-testid="account-identicon" viewBox="0 0 5 5" width="28" height="28" shape-rendering="crispEdges" aria-hidden="true"><rect width="5" height="5" fill="#d7e3f4"/>${cells}</svg>`;
}
