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
