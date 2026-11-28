// Software WebAuthn authenticator (ES256) for Node e2e runs, shaped like the navigator.credentials surface src/passkey.ts uses.
import { webcrypto } from "node:crypto";

export async function softAuthenticator() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = await webcrypto.subtle.exportKey("spki", pair.publicKey);
  const rawId = webcrypto.getRandomValues(new Uint8Array(16));
  let assertions = 0;
  const der = (p1363: Uint8Array) => {
    const int = (b: Uint8Array) => {
      let i = 0;
      while (i < b.length - 1 && b[i] === 0) i += 1;
      const t = b[i]! >= 0x80 ? [0, ...b.slice(i)] : [...b.slice(i)];
      return [0x02, t.length, ...t];
    };
    const body = [...int(p1363.slice(0, 32)), ...int(p1363.slice(32))];
    return new Uint8Array([0x30, body.length, ...body]);
  };
  return {
    get assertions() {
      return assertions;
    },
    credentials: {
      async create() {
        return { rawId: rawId.buffer, response: { getPublicKey: () => spki } };
      },
      async get({ publicKey }: { publicKey: { challenge: Uint8Array } }) {
        assertions += 1;
        const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(publicKey.challenge).toString("base64url"), origin: "http://localhost", crossOrigin: false });
        const authenticatorData = new Uint8Array(37);
        authenticatorData[32] = 0x05; // UP | UV
        const clientHash = new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(clientDataJSON)));
        const sig = new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new Uint8Array([...authenticatorData, ...clientHash])));
        return { rawId: rawId.buffer, response: { authenticatorData: authenticatorData.buffer, clientDataJSON: new TextEncoder().encode(clientDataJSON).buffer, signature: der(sig).buffer } };
      },
    },
  };
}

