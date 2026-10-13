import { CATEGORY_ICONS } from '@codepilot/analyzer/architecture/icons';
import type { ArchNode } from '../../lib/api.ts';

/** The same monoline category glyphs the exports use, so screen and export match. */
export function CategoryIcon({ category, size = 16, color = 'currentColor' }: { category: ArchNode['category']; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flex: 'none' }}>
      <path d={CATEGORY_ICONS[category] ?? CATEGORY_ICONS.application} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
