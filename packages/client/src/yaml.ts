/**
 * Browser-safe YAML utilities — thin re-export of `@disco/core/yaml`.
 *
 * Exposed on `@disco-live/client` so UI/browser consumers can parse and emit
 * YAML without taking a direct dep on `js-yaml` (or on `@disco/core`).
 */

export * from '@disco/core/yaml';
export { default } from '@disco/core/yaml';
