import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";
import { fileURLToPath } from "node:url";

// Real Chromium WebAuthn (CDP virtual authenticator): the private-folder key comes from the passkey's PRF output,
// and a passkey without PRF is refused with the message that points to a PRF passkey or a wallet.
const ORIGIN = "https://prf.trefolders.test";

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: { entry: fileURLToPath(new URL("../src/private/key-source.ts", import.meta.url)), name: "KeySource", formats: ["iife"], fileName: () => "key-source.js" },
    },
  })) as { output: { code?: string }[] }[] | { output: { code?: string }[] };
  const first = Array.isArray(out) ? out[0]! : out;
  return first.output.find((o) => o.code)!.code!;
}

async function setup(page: Page, hasPrf: boolean) {
  const script = await bundle();
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><title>prf</title><script>${script.replace(/<\/script/g, "<\\/script")}</script>` }),
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf },
  } as never);
  await page.goto(`${ORIGIN}/`);
}

/** Make a passkey the way createPasskey does (resident, UV, prf requested) and return its base64url id. */
const makePasskey = (page: Page) =>
  page.evaluate(async () => {
    const c = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "TreFolders" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "t", displayName: "t" },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
    return btoa(String.fromCharCode(...new Uint8Array(c.rawId))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  });

test("Chromium passkey with PRF: same private-folder owner every time, signs without another prompt", async ({ page }) => {
  await setup(page, true);
  const id = await makePasskey(page);
  const result = await page.evaluate(async (credentialId) => {
    const K = (window as unknown as { KeySource: typeof import("../src/private/key-source.js") }).KeySource;
    const a = await K.unlockPasskeyOwner({ credentialId });
    K.lockPasskeyOwners();
    const b = await K.passkeyPrivateSigner({ credentialId });
    const sig = await b.signTypedData({ domain: { name: "t" }, types: { M: [{ name: "a", type: "uint256" }] }, primaryType: "M", message: { a: 1n } });
    return { a: a.address, b: b.address, stored: K.knownPasskeyOwner(credentialId), sig: sig.length };
  }, id);
  expect(result.a).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(result.b).toBe(result.a);
  expect(result.stored).toBe(result.a);
  expect(result.sig).toBe(132);
});

test("Chromium passkey without PRF: refused with the PRF-or-wallet message, nothing stored", async ({ page }) => {
  await setup(page, false);
  const id = await makePasskey(page);
  const result = await page.evaluate(async (credentialId) => {
    const K = (window as unknown as { KeySource: typeof import("../src/private/key-source.js") }).KeySource;
    try {
      await K.unlockPasskeyOwner({ credentialId });
      return { error: "", stored: K.knownPasskeyOwner(credentialId), message: K.NO_PRF_MESSAGE };
    } catch (error) {
      return { error: (error as Error).message, stored: K.knownPasskeyOwner(credentialId), message: K.NO_PRF_MESSAGE };
    }
  }, id);
  expect(result.error).toBe(result.message);
  expect(result.message).toMatch(/PRF-capable passkey, or sign in with a wallet/);
  expect(result.stored).toBeNull();
});
