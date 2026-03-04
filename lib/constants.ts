/** DOM cleanup markers */
export const GHOST_MARKER = 'ghost-ml';
export const MAIN_TAG = 'main-ghost-ml';
export const USER_INPUT_TAG = 'origin-user-input-ghost-ml';

/** Response-side tags (model output structure) */
export const RESP_TAG = 'model-response-ghost-ml';
export const INFO_CTRL_TAG = 'info-control-ghost-ml';
export const NEED_UPDATE_TAG = 'need-update-ghost-ml';
export const UPDATED_BIO_TAG = 'updated-user-bio-ghost-ml';
export const NEED_UPDATE_SOUL_TAG = 'need-update-soul-ghost-ml';
export const UPDATED_SOUL_TAG = 'updated-ai-soul-ghost-ml';

/** Cross-world message types (postMessage) */
export const MSG = {
  PROFILE_UPDATE: 'GHOST_CONTEXT::PROFILE',
  INFO_CONTROL: 'GHOST_CONTEXT::INFO_CONTROL',
} as const;

/** chrome.storage.local keys */
export const STORE = {
  /** v2 unified config object */
  CONFIG: 'ghost_config',
  /** Growth log — array of GrowthEntry */
  GROWTH_LOG: 'ghost_growth_log',
  /** Theme preference — 'system' | 'dark' | 'light' */
  THEME: 'ghost_theme',
  /** @deprecated v1 legacy keys — kept for migration only */
  PROFILE: 'ghost_profile',
  ENABLED: 'ghost_enabled',
  DEBUG: 'ghost_debug',
  SHOW_INJECTION: 'ghost_show_injection',
  REINJECT_INTERVAL: 'ghost_reinject_interval',
} as const;

export const DEFAULT_REINJECT_INTERVAL = 10;

/** Hosts supported by Qianyi (used for popup disable check) */
export const SUPPORTED_HOSTS = [
  'chat.deepseek.com',
  'gemini.google.com',
  'aistudio.google.com',
  'kimi.moonshot.cn',
  'chat.qwen.ai',
  'tongyi.aliyun.com',
  'tongyi.com',
  'qianwen.com',
  'www.qianwen.com',
];
