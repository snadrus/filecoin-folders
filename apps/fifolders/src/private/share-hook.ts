/** The open private volume's share-link maker, set when a private volume opens; null otherwise. */
export type PrivateShareMaker = (path: string, base: string) => Promise<string>;

let maker: PrivateShareMaker | null = null;

export function setPrivateShareMaker(next: PrivateShareMaker | null): void {
  maker = next;
}

export function privateShareMaker(): PrivateShareMaker | null {
  return maker;
}
