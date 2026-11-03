import { describe, expect, it } from "vitest";
import { parseShare, sharePageHtml, sharePageUrl } from "../src/share/share-page.js";

describe("guest share page (Andy decision 4)", () => {
  it("round-trips name, size and owner and shows Open/Download", () => {
    const url = sharePageUrl("https://fifolders.scionbase.ai/", { name: "Trip plan.pdf", cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", size: 2048, owner: "0x2d63000000000000000000000000000000000001", chain: "calibration" });
    expect(url).toMatch(/^https:\/\/fifolders\.scionbase\.ai\/share\/\?cid=/);
    const p = parseShare(new URL(url).search)!;
    expect(p.name).toBe("Trip plan.pdf");
    const html = sharePageHtml(p, { name: "Andy", avatar: "", hasIdentity: true });
    expect(html).toContain("Trip plan.pdf");
    expect(html).toContain("2.0 KB");
    expect(html).toContain("Andy");
    expect(html).toContain("ipfs.io/ipfs/bafybei");
    expect(html).toContain('data-testid="share-download"');
    expect(html).not.toContain(".asc");
  });
  it("rejects junk and escapes names", () => {
    expect(parseShare("?name=x")).toBeNull();
    expect(parseShare("?src=javascript:alert(1)&name=x")).toBeNull();
    const p = parseShare("?cid=bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi&name=%3Cimg%3E")!;
    expect(sharePageHtml(p, null)).toContain("&lt;img&gt;");
  });
});
