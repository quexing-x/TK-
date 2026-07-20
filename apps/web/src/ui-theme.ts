export type UiTheme = "light" | "dark";

export const UI_THEME_STORAGE_KEY = "tk-auto-ui-theme";

export function resolveUiTheme(storedTheme: string | null): UiTheme {
  return storedTheme === "dark" ? "dark" : "light";
}

export function nextUiTheme(theme: UiTheme): UiTheme {
  return theme === "light" ? "dark" : "light";
}
