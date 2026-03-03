import { STORE } from './constants';

/** Generate a short random ID for slot tracking */
export function genId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/* ══════════════════════════════════════════
 *  Injection Mode — 5-level injection depth
 * ══════════════════════════════════════════ */

export type InjectionMode = 'full' | 'lite' | 'persona' | 'time' | 'off';

export const INJECTION_MODES: { value: InjectionMode; label: string; glyph: string; brief: string; desc: string }[] = [
  { value: 'full',    glyph: '沉', label: '沉 · 全量', brief: '全部传递，反馈成长',         desc: '传递画像、身份设定、灵魂与时间，启用自主成长' },
  { value: 'lite',    glyph: '潜', label: '潜 · 轻量', brief: '让 AI 感知你与时间',         desc: '传递你的画像与时间，不启用成长' },
  { value: 'persona', glyph: '流', label: '流 · 人设', brief: '让 AI 拥有灵魂并感知时间',   desc: '传递 AI 的身份设定、灵魂与时间' },
  { value: 'time',    glyph: '漾', label: '漾 · 时间', brief: '仅传递时间',                 desc: '仅传递当前时间，修复 AI 的时间感知' },
  { value: 'off',     glyph: '浮', label: '浮 · 关闭', brief: '关闭传递',                   desc: '关闭传递，所有对话完全透传' },
];

/* ══════════════════════════════════════════
 *  User Identity — who the user is
 * ══════════════════════════════════════════ */

export interface UserIdentity {  /** Stable ID for growth log tracking */
  id: string;  /** Slot display name (e.g. "工作", "生活", "学习") */
  name: string;
  /** Free-text bio: role, tech stack, preferences, etc. */
  bio: string;
}

export const DEFAULT_IDENTITY: UserIdentity = { name: '', bio: '' };

/* ══════════════════════════════════════════
 *  AI Persona — how the AI should behave
 * ══════════════════════════════════════════ */

export interface AIPersona {  /** Stable ID for growth log tracking */
  id: string;  /** Slot display name (e.g. "技术助手", "导师", "创意") */
  name: string;
  /** Identity: who the AI is — role, expertise, background (relatively stable) */
  identity: string;
  /** Soul: how the AI thinks & communicates — reasoning style, tone, expression logic (can grow) */
  soul: string;
}

export const DEFAULT_PERSONA: AIPersona = { name: '', identity: '', soul: '' };

/* ══════════════════════════════════════════
 *  Slot system — 3 quick-switch slots each
 * ══════════════════════════════════════════ */

export const MAX_SLOTS = 3;

/* ══════════════════════════════════════════
 *  GhostConfig — top-level config envelope
 * ══════════════════════════════════════════ */

export interface GhostConfig {
  /** Schema version for future migration */
  version: number;

  /** Injection depth */
  mode: InjectionMode;

  /** Identity slots (up to MAX_SLOTS) */
  identities: UserIdentity[];
  /** Currently active identity index (0-based, -1 = none) */
  activeIdentity: number;

  /** Persona slots (up to MAX_SLOTS) */
  personas: AIPersona[];
  /** Currently active persona index (0-based, -1 = none) */
  activePersona: number;

  /** Re-inject every N turns (0 = only on new session) */
  reinjectInterval: number;

  /** Debug mode */
  debug: boolean;
  /** Show injection preview panel (debug sub-option) */
  showInjection: boolean;
}

export const DEFAULT_CONFIG: GhostConfig = {
  version: 2,
  mode: 'full',
  identities: [
    { id: genId(), name: '默认', bio: '' },
  ],
  activeIdentity: 0,
  personas: [
    { id: genId(), name: '默认', identity: '', soul: '' },
  ],
  activePersona: 0,
  reinjectInterval: 10,
  debug: false,
  showInjection: false,
};

/* ══════════════════════════════════════════
 *  Legacy UserProfile — kept for v1→v2 migration
 * ══════════════════════════════════════════ */

export interface UserProfile {
  bio: string;
  persona: string;
  style: string;
}

/* ══════════════════════════════════════════
 *  Resolved injection context
 *  — what actually gets sent to the MAIN world
 * ══════════════════════════════════════════ */

export interface InjectionContext {
  mode: InjectionMode;
  identity: UserIdentity | null;
  persona: AIPersona | null;
  reinjectInterval: number;
  debug: boolean;
}

/** Derive the injection context from config */
export function resolveContext(config: GhostConfig): InjectionContext {
  const identity = config.activeIdentity >= 0
    ? config.identities[config.activeIdentity] ?? null
    : null;
  const persona = config.activePersona >= 0
    ? config.personas[config.activePersona] ?? null
    : null;
  return {
    mode: config.mode,
    identity,
    persona,
    reinjectInterval: config.reinjectInterval,
    debug: config.debug,
  };
}

/** Check if there's any injectable content in the resolved context */
export function isContextEmpty(ctx: InjectionContext): boolean {
  if (ctx.mode === 'off' || ctx.mode === 'time') return true;
  if (ctx.mode === 'persona') return !ctx.persona?.identity && !ctx.persona?.soul;
  // full / lite
  const hasIdentity = !!ctx.identity?.bio;
  const hasPersona = !!ctx.persona?.identity || !!ctx.persona?.soul;
  return !hasIdentity && !hasPersona;
}

/* ══════════════════════════════════════════
 *  Storage helpers
 * ══════════════════════════════════════════ */

export async function loadConfig(): Promise<GhostConfig> {
  const data = await browser.storage.local.get([STORE.CONFIG, STORE.PROFILE]);

  // v2 config exists — backfill IDs if missing (v2→v2.1 migration)
  if (data[STORE.CONFIG]?.version === 2) {
    const cfg = data[STORE.CONFIG] as GhostConfig;
    let patched = false;
    for (const slot of cfg.identities) {
      if (!slot.id) { slot.id = genId(); patched = true; }
    }
    for (const slot of cfg.personas) {
      if (!slot.id) { slot.id = genId(); patched = true; }
    }
    if (patched) await saveConfig(cfg);
    return cfg;
  }

  // Migrate from v1 (legacy flat UserProfile + separate flags)
  const legacy = data[STORE.PROFILE] as UserProfile | undefined;
  const flags = await browser.storage.local.get([
    STORE.ENABLED, STORE.DEBUG, STORE.SHOW_INJECTION, STORE.REINJECT_INTERVAL,
  ]);

  const config: GhostConfig = { ...DEFAULT_CONFIG };

  if (legacy) {
    config.identities = [{ id: genId(), name: '默认', bio: legacy.bio || '' }];
    config.personas = [{ id: genId(), name: '默认', identity: legacy.persona || '', soul: legacy.style || '' }];
  }

  // Carry over v1 flags
  if (flags[STORE.ENABLED] === false) config.mode = 'off';
  if (flags[STORE.DEBUG] != null) config.debug = flags[STORE.DEBUG];
  if (flags[STORE.SHOW_INJECTION] != null) config.showInjection = flags[STORE.SHOW_INJECTION];
  if (flags[STORE.REINJECT_INTERVAL] != null) config.reinjectInterval = flags[STORE.REINJECT_INTERVAL];

  // Persist migrated config & clean up legacy keys
  await saveConfig(config);
  return config;
}

export async function saveConfig(config: GhostConfig): Promise<void> {
  await browser.storage.local.set({ [STORE.CONFIG]: config });
}
