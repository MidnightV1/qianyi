import type { UserProfile } from './profile';
import {
  MAIN_TAG, USER_INPUT_TAG,
  RESP_TAG, INFO_CTRL_TAG, NEED_UPDATE_TAG, UPDATED_BIO_TAG,
} from './constants';

/**
 * Build the full injected prompt.
 *
 * Structure:
 * ```
 * <main-ghost-ml>
 * # 首要任务
 * 以下为用户背景信息和对回复的要求，请结合这些信息回复用户请求。
 *   <current-date-time>...</current-date-time>
 *   <user-bio>...</user-bio>
 *   <your-persona>...</your-persona>
 *   <style-guide>...</style-guide>
 * # 回复要求
 * - 你的回复要严格使用以下格式输出，不要添加任何多余内容。
 * <model-response-ghost-ml>
 * 你结合了相关信息后生成的回复内容，除了xml格式之外，剩余要求与你收到的要求完全一致。
 * </model-response-ghost-ml>
 * <info-control-ghost-ml>
 * 完成对用户的回复后，你要在这里额外输出一段用于后续处理的信息，内容如下：
 * <need-update-ghost-ml>
 * 基于对话内容，你是否认为需要更新用户的背景信息
 * true/false
 * </need-update-ghost-ml>
 * <updated-user-bio-ghost-ml>
 * 如果上面是true，这里重写最新的、完整的user-bio，注意确保语言简洁明了，做最小变更，尽量消除冲突和歧义。
 * 如果上面是false，无需输出该单元块
 * </updated-user-bio-ghost-ml>
 * </main-ghost-ml>
 * <origin-user-input-ghost-ml>
 *   (用户原始输入)
 * </origin-user-input-ghost-ml>
 * ```
 */
export function formatInjection(profile: UserProfile, userInput: string): string {
  const parts: string[] = [];

  parts.push(`<${MAIN_TAG}>`);

  /* ── Section 1: 用户背景 ── */
  parts.push('# 首要任务');
  parts.push('以下为用户背景信息和对回复的要求，请结合这些信息回复用户请求。');

  const now = new Date();
  const dateTime = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  parts.push(`<current-date-time>${dateTime}</current-date-time>`);

  if (profile.bio) parts.push(`<user-bio>${profile.bio}</user-bio>`);
  if (profile.persona) parts.push(`<your-persona>${profile.persona}</your-persona>`);
  if (profile.style) parts.push(`<style-guide>${profile.style}</style-guide>`);

  /* ── Section 2: 回复格式要求 ── */
  parts.push('# 回复要求');
  parts.push('- 你的回复要严格使用以下格式输出，不要添加任何多余内容。');
  parts.push(`<${RESP_TAG}>`);
  parts.push('你结合了相关信息后生成的回复内容，除了xml格式之外，剩余要求与你收到的要求完全一致。');
  parts.push(`</${RESP_TAG}>`);
  parts.push(`<${INFO_CTRL_TAG}>`);
  parts.push('完成对用户的回复后，你要在这里额外输出一段用于后续处理的信息，内容如下：');
  parts.push(`<${NEED_UPDATE_TAG}>`);
  parts.push('基于对话内容，你是否认为需要更新用户的背景信息');
  parts.push('true/false');
  parts.push(`</${NEED_UPDATE_TAG}>`);
  parts.push(`<${UPDATED_BIO_TAG}>`);
  parts.push('如果上面是true，这里重写最新的、完整的user-bio，注意确保语言简洁明了，做最小变更，尽量消除冲突和歧义。');
  parts.push('如果上面是false，无需输出该单元块');
  parts.push(`</${UPDATED_BIO_TAG}>`);
  parts.push(`</${INFO_CTRL_TAG}>`);

  parts.push(`</${MAIN_TAG}>`);

  parts.push(`<${USER_INPUT_TAG}>`);
  parts.push(userInput);
  parts.push(`</${USER_INPUT_TAG}>`);

  return parts.join('\n');
}

/**
 * Lightweight injection: only prepend current datetime to the user's input.
 * Used when the main injection switch is OFF.
 */
export function formatTimeOnlyInjection(userInput: string): string {
  const now = new Date();
  const dateTime = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `<current-date-time>${dateTime}</current-date-time>\n${userInput}`;
}
