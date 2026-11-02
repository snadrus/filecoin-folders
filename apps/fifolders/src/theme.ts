export type ThemeName = "light";

/** FiFolders always uses the bright Drive-like palette, whatever the system scheme. */
export function applyTheme(root: HTMLElement = document.documentElement): void {
  root.dataset.theme = "light";
  root.style.colorScheme = "light";
}
