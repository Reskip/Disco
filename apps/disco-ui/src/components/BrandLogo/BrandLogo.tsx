import { theme } from 'antd';
import type { CSSProperties } from 'react';
import { BRAND } from '../../branding/brand';

export interface BrandLogoProps {
  /**
   * Typography level (1-5)
   * @default 3
   */
  level?: 1 | 2 | 3 | 4 | 5;
  /**
   * Additional styles to apply
   */
  style?: CSSProperties;
  /**
   * Custom class name
   */
  className?: string;
}

// Font size mapping based on Ant Design's Title levels (increased by ~12.5%)
const LEVEL_SIZES = {
  1: '43px',
  2: '34px',
  3: '27px',
  4: '23px',
  5: '18px',
} as const;

/**
 * Standalone Disco wordmark. The spherical mark is intentionally not embedded
 * here because compact headers and favicons use the mark independently.
 */
export const BrandLogo: React.FC<BrandLogoProps> = ({ level = 3, style, className }) => {
  const { token } = theme.useToken();
  const gradientStyle: CSSProperties = {
    margin: 0,
    fontSize: LEVEL_SIZES[level],
    lineHeight: 1.35,
    color: token.colorText,
    fontWeight: 520,
    letterSpacing: '-0.045em',
    width: 'fit-content',
    ...style,
  };

  return (
    <h1 className={className} style={gradientStyle}>
      {BRAND.name.toLowerCase()}
    </h1>
  );
};
