import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "sources/app/chimera/control");

describe("Chimera Control static contract", () => {
    it("uses only local assets and exposes the three management sections", async () => {
        const html = await readFile(join(root, "index.html"), "utf8");
        expect(html).toContain('href="./control.css"');
        expect(html).toContain('src="./control.js"');
        expect(html).not.toMatch(/(?:href|src)="https?:\/\//);
        expect(html.match(/data-section=/g)).toHaveLength(3);
        expect(html).toContain('autocomplete="current-password"');
        expect(html).not.toMatch(/<script(?![^>]*src=)/);
    });

    it("keeps invite plaintext ephemeral and renders API data without HTML insertion", async () => {
        const script = await readFile(join(root, "control.js"), "utf8");
        expect(script).toContain("X-Chimera-CSRF");
        expect(script).toContain("navigator.clipboard.writeText");
        expect(script).toContain("textContent");
        expect(script).not.toContain("innerHTML");
        expect(script).toContain("clearInviteCode");
        expect(script).toContain("/chimera-control/api/invitations");
        expect(script).toContain("/chimera-control/api/config");
        expect(script).toContain("/chimera-control/api/accounts");
    });
});
