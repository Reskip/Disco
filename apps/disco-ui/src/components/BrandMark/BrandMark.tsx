import { theme } from 'antd';
import type { CSSProperties } from 'react';
import { brandMarkHref } from '../../branding/brand';
import { useOptionalTheme } from '../../contexts/ThemeContext';
import { isDarkTheme } from '../../utils/theme';

export interface BrandMarkProps {
  /** Square rendered size in CSS pixels. */
  size?: number;
  style?: CSSProperties;
  className?: string;
}

/**
 * Theme-aware multicolor Disco mark. The SVG geometry is shared between both
 * variants; only the palette changes, so small app icons and larger branding
 * always keep the same silhouette.
 */
export function BrandMark({ size = 32, style, className }: BrandMarkProps) {
  const { token } = theme.useToken();
  const themeContext = useOptionalTheme();
  const dark = themeContext?.isDark ?? isDarkTheme(token);

  return (
    <img
      aria-hidden="true"
      alt=""
      draggable={false}
      className={className}
      data-brand-mark={dark ? 'dark' : 'light'}
      src={brandMarkHref(undefined, dark ? 'dark' : 'light')}
      style={{
        display: 'block',
        width: size,
        height: size,
        objectFit: 'contain',
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
