// Light or dark, chosen per device. "system" follows the device setting; an explicit choice sets data-theme on the root,
// which the stylesheet reads. Kept in localStorage (not synced) because a phone and a laptop often want different answers.
export type ThemeChoice = "system" | "light" | "dark";
const KEY = "lb-theme";
const BAR = { light: "#F7F7FB", dark: "#14112A" };
const listeners = new Set<() => void>();

export function themeChoice(): ThemeChoice {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
}
export const isDark = () => { const c = themeChoice(); return c === "dark" || (c === "system" && matchMedia("(prefers-color-scheme: dark)").matches); };

export function applyTheme() {
  const c = themeChoice(), root = document.documentElement;
  if (c === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", c);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", isDark() ? BAR.dark : BAR.light);
  listeners.forEach(f => f());
}
export function setTheme(c: ThemeChoice) {
  try { if (c === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, c); } catch { /* private mode: applies until reload */ }
  if (c === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", c);
  applyTheme();
}
/** The header button: flips to the opposite of what's showing now. */
export const toggleTheme = () => setTheme(isDark() ? "light" : "dark");
export const onTheme = (f: () => void) => { listeners.add(f); return () => listeners.delete(f); };

export function initTheme() {
  applyTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (themeChoice() === "system") applyTheme(); });
  addEventListener("storage", e => { if (e.key === KEY) applyTheme(); }); // another tab changed it
}
