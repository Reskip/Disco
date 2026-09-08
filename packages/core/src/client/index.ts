/**
 * Client-safe @disco/core surface for browser/SDK consumers.
 *
 * This entrypoint must stay free of Node-only SDK/runtime imports AND of
 * Handlebars (which uses `new Function` and would force browsers to ship
 * with CSP `script-src 'unsafe-eval'`). Server-side renderers should import
 * directly from `@disco/core/templates/handlebars-helpers` instead.
 */

export type {
  ClientInput,
  DiscoClient,
  DiscoService,
  FindResult,
  LeaderboardService,
  MessagesService,
  SchedulesService,
  ServiceTypes,
  SessionPromptOptions,
  SessionPromptResult,
  SessionSearchService,
  SessionsService,
  TaskRunOptions,
  TaskRunRequest,
  TasksClientHelpers,
  TasksService,
  TemplateRenderRequest,
  TemplateRenderResponse,
  TemplatesService,
} from '../api/index.js';
export {
  createClient,
  createRestClient,
  getApiKeyFromEnv,
  isDaemonRunning,
} from '../api/index.js';

export * from '../config/browser.js';
export type { DiscoConfig } from '../config/types.js';
// Global-search field registry — same module on client (V1 in-memory filter)
// and server (future V2 SQL fan-out per design doc §5.7).
export {
  matchSearchTokens,
  SEARCHABLE_FIELDS,
  type SearchFieldExtractor,
  tokenizeSearchQuery,
} from '../search/index.js';
export * from '../types/index.js';
// Cron helpers — pure functions, browser-safe (cron-parser + cronstrue
// both ship browser builds). Drives the schedules UI's live "Every
// hour" preview, IANA-tz validation, and the visual cron picker preset.
export {
  CRON_PRESETS,
  type CronValidationResult,
  getNextRuns,
  getNextRunTime,
  getPrevRunTime,
  humanizeCron,
  isValidCron,
  resolveScheduleTz,
  roundToMinute,
  validateCron,
  validateCronWithResult,
} from '../utils/cron.js';
// Permission-mode helpers — pure functions, browser-safe.
export {
  type CodexPermissionDefaults,
  getDefaultCodexPermissionConfig,
  mapPermissionMode,
  mapToCodexPermissionConfig,
} from '../utils/permission-mode-mapper.js';
// Session URL/path builders shared by daemon responses and the UI router.
export {
  ENTITY_PATH_SEGMENTS,
  getSessionUrl,
  sessionPath,
  UI_MOUNT_PATH,
} from '../utils/url.js';
