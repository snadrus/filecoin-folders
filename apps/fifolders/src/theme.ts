export type ThemeName = "light" | "dark";

export function themeForScheme(prefersDark: boolean): ThemeName {
  return prefersDark ? "dark" : "light";
}

export function applyTheme(theme: ThemeName, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function watchSystemTheme(apply: (theme: ThemeName) => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const update = () => apply(themeForScheme(media.matches));
  update();
  media.addEventListener("change", update);
  return () => media.removeEventListener("change", update);
}
