import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STYLE } from "../src/http/style.js";

/**
 * design/tokens.json is the source of truth for the view's colours
 * (design/DESIGN.md). These tests hold style.ts to it, one custom property
 * per token in both themes, and recompute the contrast table of DESIGN.md
 * from the tokens themselves, with the WCAG 2.2 relative-luminance formula.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const tokens = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "design", "tokens.json"), "utf8")) as {
  color: { light: Record<string, string>; dark: Record<string, string> };
};

/** The custom properties a block of CSS declares, colours only. */
function declaredColours(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of block.matchAll(/--([a-z-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name === undefined || value === undefined || /^(shadow|font|mono)/.test(name)) continue;
    found.set(name, value.trim().toLowerCase().replaceAll(" ", ""));
  }
  return found;
}

const lightBlock = /:root \{([^}]*)\}/.exec(STYLE)?.[1] ?? "";
const darkBlock = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(STYLE)?.[1] ?? "";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/** DESIGN.md's contrast table: foreground, the backgrounds it is used on, and what WCAG asks. */
const PAIRS: [foreground: string, backgrounds: string[], required: number][] = [
  ["text", ["bg", "canvas", "sidebar", "surface", "fill", "current", "segment", "segment-on", "hover", "ok-fill", "warn-fill", "bad-fill"], 4.5],
  ["secondary", ["bg", "canvas", "sidebar", "surface", "fill", "current", "segment", "hover"], 4.5],
  ["label", ["bg", "canvas", "surface", "fill"], 4.5],
  ["link", ["bg", "canvas", "sidebar", "surface", "fill"], 4.5],
  ["ok", ["bg", "canvas", "sidebar", "surface", "ok-fill"], 4.5],
  ["warn", ["bg", "canvas", "sidebar", "surface", "warn-fill"], 4.5],
  ["bad", ["bg", "canvas", "sidebar", "surface", "bad-fill"], 4.5],
  ["on-action", ["action", "selection", "danger"], 4.5],
  ["control", ["bg", "canvas", "sidebar", "surface", "fill"], 3],
  ["focus", ["bg", "canvas", "sidebar", "surface"], 3],
  ["brand", ["bg", "canvas", "sidebar"], 3],
  ["kind-tool", ["kind-tool-fill"], 3],
  ["kind-model", ["kind-model-fill"], 3],
  ["kind-step", ["kind-step-fill"], 3],
  ["kind-decision", ["kind-decision-fill"], 3],
  ["kind-genesis", ["kind-genesis-fill"], 3],
];

describe("the stylesheet and design/tokens.json", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`declares every ${theme} colour token, with its value, and no colour that is not a token`, () => {
      const declared = declaredColours(theme === "light" ? lightBlock : darkBlock);
      const expected = new Map(
        Object.entries(tokens.color[theme]).map(([name, value]) => [name, value.toLowerCase().replaceAll(" ", "")]),
      );
      expect(declared.size).toBeGreaterThan(30);
      expect(Object.fromEntries(declared)).toEqual(Object.fromEntries(expected));
    });
  }

  it("gives every token a dark value", () => {
    expect(Object.keys(tokens.color.dark).sort()).toEqual(Object.keys(tokens.color.light).sort());
  });

  for (const theme of ["light", "dark"] as const) {
    it(`meets WCAG 2.2 AA contrast in the ${theme} theme: 4.5:1 for text, 3:1 for controls and meaningful icons`, () => {
      const colours = tokens.color[theme];
      const failures: string[] = [];
      for (const [foreground, backgrounds, required] of PAIRS) {
        for (const background of backgrounds) {
          const fg = colours[foreground];
          const bg = colours[background];
          expect(fg, foreground).toMatch(/^#[0-9A-F]{6}$/i);
          expect(bg, background).toMatch(/^#[0-9A-F]{6}$/i);
          const ratio = contrast(fg ?? "", bg ?? "");
          if (ratio < required) failures.push(`${foreground} on ${background}: ${ratio.toFixed(2)} < ${required}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it("matches the two corrections DESIGN.md records against the mockups", () => {
    // The mockups' secondary grey fails on the sidebar; their field border fails 3:1 on white.
    expect(contrast("#6E6E73", tokens.color.light["sidebar"] ?? "")).toBeLessThan(4.5);
    expect(contrast("#C7C7CC", "#FFFFFF")).toBeLessThan(3);
    expect(tokens.color.light["secondary"]).toBe("#636366");
    expect(tokens.color.light["control"]).toBe("#8A8A8E");
  });

  it("never sets the selected segment's count in the secondary grey, which fails on it in the dark theme", () => {
    expect(contrast(tokens.color.dark["secondary"] ?? "", tokens.color.dark["segment-on"] ?? "")).toBeLessThan(4.5);
    expect(STYLE).toContain('.segmented a[aria-current="page"] .count { color: var(--text); }');
  });
});
