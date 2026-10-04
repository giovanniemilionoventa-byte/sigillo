import { it as vitestIt, type TestFunction } from "vitest";
import { withLanguage } from "../../src/http/locale.js";

/**
 * vitest's `it`, with every test body run in Italian (http/locale.ts). The
 * tests that import it were written against the Italian text and still check
 * it word for word; a request they make with no language of its own is
 * answered in Italian too (ui.ts passes the surrounding language on).
 * language.test.ts covers English, the default, and the switch between them.
 */
export function it(name: string, test?: TestFunction, timeout?: number): void {
  if (test === undefined) {
    vitestIt.todo(name);
    return;
  }
  vitestIt(name, (context) => withLanguage("it", "/ui/login", () => test(context)), timeout);
}
