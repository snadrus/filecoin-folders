// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { cachedIdentity, normalizeIdentity, openIdentityPopup, personChipHtml } from "../src/view/index.js";

const A = "0x3333333333333333333333333333333333333333";

describe("popup", () => {
  it("guest: Configure your identity + local rename; identity: name + Edit", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    let renamed = false;
    const pop = openIdentityPopup(anchor, { person: cachedIdentity(A), href: "/identity/?return=x", onLocalRename: () => (renamed = true) });
    expect(pop.textContent).toContain("Configure your identity");
    expect(pop.querySelector("[data-testid=identity-pop-configure]")!.getAttribute("href")).toBe("/identity/?return=x");
    pop.querySelector<HTMLButtonElement>("[data-testid=identity-pop-local]")!.click();
    expect(renamed).toBe(true);
    expect(document.querySelector("#identity-pop")).toBeNull();
    const identity = normalizeIdentity(A, { displayName: "Andy <b>", avatar: { emoji: "🦊" } });
    const shown = openIdentityPopup(anchor, { person: { address: A, displayName: identity.displayName, avatar: identity.avatar, source: "cache", identity }, href: "/identity/" });
    expect(shown.querySelector("[data-testid=identity-pop-name]")!.textContent).toBe("Andy <b>");
    expect(shown.querySelector("[data-testid=identity-pop-edit]")).toBeTruthy();
    expect(personChipHtml({ displayName: "<x>" })).toContain("&lt;x&gt;");
  });
});

describe("avatar picture", () => {
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  it("renders the picture instead of the emoji or pixel avatar", async () => {
    const { avatarHtml } = await import("../src/view/index.js");
    const html = avatarHtml({ address: "0x" + "1".repeat(40), displayName: "A", avatar: { emoji: "🦊", image } }, 32);
    expect(html).toContain('data-kind="image"');
    expect(html).toContain("<img");
    expect(html).not.toContain("🦊");
  });
  it("normalizes: keeps safe data URLs, drops others and oversized ones", async () => {
    const { normalizeIdentity, AVATAR_IMAGE_MAX } = await import("../src/view/index.js");
    const a = "0x" + "1".repeat(40);
    expect(normalizeIdentity(a, { displayName: "A", avatar: { image } }).avatar?.image).toBe(image);
    expect(normalizeIdentity(a, { displayName: "A", avatar: { image: "javascript:alert(1)" } }).avatar).toBeUndefined();
    expect(normalizeIdentity(a, { displayName: "A", avatar: { image: "data:image/svg+xml;base64,PHN2Zz4=" } }).avatar).toBeUndefined();
    const big = "data:image/png;base64," + "A".repeat(AVATAR_IMAGE_MAX);
    expect(normalizeIdentity(a, { displayName: "A", avatar: { image: big } }).avatar).toBeUndefined();
  });
});
