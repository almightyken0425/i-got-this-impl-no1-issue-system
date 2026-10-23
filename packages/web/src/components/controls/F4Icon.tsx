import { F4_LAYOUT, useTheme } from '../../theme';
import type { ButtonHTMLAttributes } from 'react';
const F4_PATHS = {
  list: 'M5 6h15M5 12h15M5 18h15M2 6h.01M2 12h.01M2 18h.01',
  kanban: 'M4 4v15M12 4v10M20 4v15M2 4h4M10 4h4M18 4h4',
  timeline: 'M3 4v16h18M7 7h7M10 12h9M6 17h7',
  types: 'M12 2 3 7l9 5 9-5-9-5ZM3 12l9 5 9-5M3 17l9 5 9-5',
  workflow: 'M3 6h7v5h10M16 7l4 4-4 4M3 18h7v-7',
  organization: 'M12 3v6M5 15v-6h14v6M2 19h6M9 3h6M16 19h6M12 9v10',
  account: 'M8 6a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21v-2a8 8 0 0 1 16 0v2',
  plus: 'M12 4v16M4 12h16',
  refresh: 'M20 7a9 9 0 1 0 1 9M20 2v5h-5',
  close: 'M5 5l14 14M5 19 19 5',
  arrow: 'M19 12H5M11 6l-6 6 6 6',
  issue: 'M6 2h9l5 5v15H6zM15 2v6h5M10 12h6M10 16h6',
  history: 'M3 6v5h5M3 11a9 9 0 1 1 2 8M12 7v6l4 2',
  relation: 'M9 14l6-6M8 17l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 7l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
} as const;

export type F4IconName = keyof typeof F4_PATHS;
export function F4Icon({ name, size = 20 }: { readonly name: F4IconName; readonly size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={F4_PATHS[name]} /></svg>;
}
export function F4Action({ name, label, ...props }: { readonly name: F4IconName; readonly label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const { theme } = useTheme();
  return <button {...props} type="button" aria-label={label} title={label} style={{ display: 'inline-grid', placeItems: 'center', width: F4_LAYOUT.touchTarget, minHeight: F4_LAYOUT.touchTarget, flexShrink: 0, border: 0, borderRadius: F4_LAYOUT.controlRadius, background: theme.bg.surface_hover, color: theme.text.secondary, cursor: 'pointer', ...props.style }}><F4Icon name={name} /></button>;
}
