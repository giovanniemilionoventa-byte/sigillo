import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The language a page is written in: English, or Italian for a reader who
 * chose it or whose browser asks for it first.
 *
 * Each request of the web view runs inside `withLanguage` (ui.ts wraps every
 * route's handler), so the text in strings.ts can follow the reader without
 * every page function passing a language down. Outside a request, as in a
 * test calling a page function directly, the text is English.
 */

export type Language = "en" | "it";

export const DEFAULT_LANGUAGE: Language = "en";

/** The cookie that remembers the reader's choice: "en" or "it". Not a secret, not a session. */
export const LANGUAGE_COOKIE = "sigillo_lang";

interface RequestLanguage {
  language: Language;
  /** Where the language switch on a sign-in page sends the reader back to. */
  back: string;
}

const current = new AsyncLocalStorage<RequestLanguage>();

export function withLanguage<T>(language: Language, back: string, run: () => T): T {
  return current.run({ language, back }, run);
}

export function currentLanguage(): Language {
  return current.getStore()?.language ?? DEFAULT_LANGUAGE;
}

/** The page the reader is on, for the language switch to return to; the sign-in page outside a request. */
export function currentBack(): string {
  return current.getStore()?.back ?? "/ui/login";
}

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "it";
}

/**
 * The language for a request: the one chosen and kept in the cookie, or else
 * the first of English and Italian in the browser's Accept-Language, by its
 * weights; else `fallback`. ui.ts passes the language already around the
 * request, which is English in a running server, and Italian for a request a
 * test written against the Italian text makes from inside withLanguage.
 */
export function languageFor(chosen: string | undefined, acceptLanguage: string | undefined, fallback = DEFAULT_LANGUAGE): Language {
  if (isLanguage(chosen)) return chosen;
  if (acceptLanguage === undefined) return fallback;
  const ranked = acceptLanguage
    .split(",")
    .map((entry, index) => {
      const [tag = "", ...parameters] = entry.trim().toLowerCase().split(";");
      const weight = parameters.map((parameter) => /^\s*q=([0-9.]+)\s*$/.exec(parameter)?.[1]).find((q) => q !== undefined);
      return { primary: tag.split("-")[0] ?? "", q: weight === undefined ? 1 : Number(weight), index };
    })
    .filter((entry) => entry.q > 0 && !Number.isNaN(entry.q))
    .sort((a, b) => b.q - a.q || a.index - b.index);
  const first = ranked.find((entry) => isLanguage(entry.primary));
  return first === undefined ? fallback : (first.primary as Language);
}
