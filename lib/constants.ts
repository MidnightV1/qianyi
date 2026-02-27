/** DOM cleanup markers */
export const GHOST_MARKER = 'ghost-ml';
export const MAIN_TAG = 'main-ghost-ml';
export const USER_INPUT_TAG = 'origin-user-input-ghost-ml';

/** Response-side tags (model output structure) */
export const RESP_TAG = 'model-response-ghost-ml';
export const INFO_CTRL_TAG = 'info-control-ghost-ml';
export const NEED_UPDATE_TAG = 'need-update-ghost-ml';
export const UPDATED_BIO_TAG = 'updated-user-bio-ghost-ml';

/** Cross-world message types (postMessage) */
export const MSG = {
  PROFILE_UPDATE: 'GHOST_CONTEXT::PROFILE',
  INFO_CONTROL: 'GHOST_CONTEXT::INFO_CONTROL',
} as const;

/** chrome.storage.local keys */
export const STORE = {
  PROFILE: 'ghost_profile',
  ENABLED: 'ghost_enabled',
  DEBUG: 'ghost_debug',
  SHOW_INJECTION: 'ghost_show_injection',
  /** Re-inject every N turns (0 = only on new session) */
  REINJECT_INTERVAL: 'ghost_reinject_interval',
} as const;

export const DEFAULT_REINJECT_INTERVAL = 10;
