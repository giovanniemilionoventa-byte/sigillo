import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whether the page being written belongs to the redesigned console
 * (SIGILLO_CONSOLE_V2, design/DESIGN.md "Il filo e il sigillo").
 *
 * ui.ts decides it once per request, from the switch and the viewer, and runs
 * the handler inside `withConsoleV2`; the shell (layout.ts), the system header
 * (history.ts) and the new pages (pages-v2.ts) read it here, so no page
 * function has to pass it down. Outside a request, as in a test calling a page
 * function directly, it is the console as it was.
 */

const current = new AsyncLocalStorage<boolean>();

export function withConsoleV2<T>(on: boolean, run: () => T): T {
  return current.run(on, run);
}

export function consoleV2(): boolean {
  return current.getStore() ?? false;
}

/** Who a switch of CLAUDE.md rule 11 lets in: everyone, the operator's own account only, or nobody. */
export function switchAllows(access: "off" | "operator" | "all" | undefined, operator: boolean): boolean {
  return access === "all" || (access === "operator" && operator);
}
