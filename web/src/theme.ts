export type Theme = 'dark' | 'light';

const THEME_KEY = 'twinview-theme';
const VIEWPORT_KEY = 'twinview-viewport';

export interface ViewportPreset {
  id: string;
  label: string;
  css: string;
}

export const VIEWPORT_PRESETS: ViewportPreset[] = [
  { id: 'graphite', label: 'Graphite', css: '#0b0e13' },
  { id: 'charcoal', label: 'Charcoal', css: '#1d222c' },
  { id: 'slate', label: 'Slate', css: '#39424f' },
  { id: 'blueprint', label: 'Blueprint', css: '#16324f' },
  { id: 'steel', label: 'Steel', css: '#9aa5b1' },
  { id: 'mist', label: 'Mist', css: '#e4e9f1' },
  { id: 'studio', label: 'Studio', css: '#f8fafc' },
];

const AUTO_BG: Record<Theme, string> = { dark: '#0b0e13', light: '#e4e9f1' };

export function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

/** Viewport setting: 'auto' (match panels) | a preset id | '#rrggbb' from the custom picker. */
export function initialViewport(): string {
  return localStorage.getItem(VIEWPORT_KEY) ?? 'auto';
}

export function saveViewport(viewport: string): void {
  localStorage.setItem(VIEWPORT_KEY, viewport);
}

export function viewportCss(viewport: string, theme: Theme): string {
  if (viewport === 'auto') return AUTO_BG[theme];
  return VIEWPORT_PRESETS.find((p) => p.id === viewport)?.css ?? viewport;
}
