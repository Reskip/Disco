// biome-ignore-all lint/plugin/noHardcodedColorLiteral: user-approved sequential palette for token-usage data visualization

// Soft gold (option A): intensity increases in order, independently of button states.
export const TOKEN_HEATMAP_PALETTE = {
  dark: ['#303138', '#4c4434', '#726044', '#99835b', '#bba475'],
  light: ['#f0f0ed', '#eee5d4', '#d8c39b', '#b79a63', '#876a33'],
} as const;
