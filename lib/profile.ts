import { STORE } from './constants';

export interface UserProfile {
  /** 个人简介：你是谁、做什么、技术栈等 */
  bio: string;
  /** AI 人设：希望 AI 扮演什么角色 */
  persona: string;
  /** 风格要求：语气、格式、长度等偏好 */
  style: string;
}

export const DEFAULT_PROFILE: UserProfile = {
  bio: '',
  persona: '',
  style: '',
};

export function isProfileEmpty(p: UserProfile): boolean {
  return !p.bio && !p.persona && !p.style;
}

/* ── Storage helpers (isolated / extension context only) ── */

export async function loadProfile(): Promise<UserProfile> {
  const data = await browser.storage.local.get(STORE.PROFILE);
  return data[STORE.PROFILE] ?? { ...DEFAULT_PROFILE };
}

export async function saveProfile(profile: UserProfile): Promise<void> {
  await browser.storage.local.set({ [STORE.PROFILE]: profile });
}
