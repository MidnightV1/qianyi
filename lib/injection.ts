import type { InjectionContext } from './profile';
import {
  MAIN_TAG, USER_INPUT_TAG,
  RESP_TAG, INFO_CTRL_TAG, NEED_UPDATE_TAG, UPDATED_BIO_TAG,
  NEED_UPDATE_SOUL_TAG, UPDATED_SOUL_TAG,
} from './constants';

/* ══════════════════════════════════════════
 *  Current datetime helper
 * ══════════════════════════════════════════ */

function currentDateTime(): string {
  const now = new Date();
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ` +
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/* ══════════════════════════════════════════
 *  Format injection — mode-aware
 * ══════════════════════════════════════════
 *
 * Modes:
 *   full    → identity + persona + style + time + response-format + info-control
 *   lite    → identity + persona + style + time + response-format (NO info-control)
 *   persona → persona + style + time + response-format (NO identity, NO info-control)
 *   time    → time only (no ghost-ml structure)
 *   off     → passthrough (should not be called)
 */
export function formatInjection(ctx: InjectionContext, userInput: string): string {
  const { mode, identity, persona } = ctx;

  // Time-only: lightweight, no ghost-ml structure
  if (mode === 'time') {
    return `<current-date-time>${currentDateTime()}</current-date-time>\n${userInput}`;
  }

  // Off: should not reach here, but passthrough just in case
  if (mode === 'off') return userInput;

  const parts: string[] = [];
  parts.push(`<${MAIN_TAG}>`);

  /* ── Section 1: 理解用户 ── */
  parts.push('# 理解用户');
  parts.push('结合以下用户资料，理解用户，并调整你的回应方式。');

  parts.push(`<current-date-time>${currentDateTime()}</current-date-time>`);

  // User bio (full / lite only)
  if ((mode === 'full' || mode === 'lite') && identity?.bio) {
    parts.push(`<user-bio>${identity.bio}</user-bio>`);
  }

  // AI identity & soul (full / lite / persona)
  if (persona?.identity) {
    parts.push(`<ai-identity>${persona.identity}</ai-identity>`);
  }
  if (persona?.soul) {
    parts.push(`<ai-soul>${persona.soul}</ai-soul>`);
  }

  /* ── Section 2: 回复要求 ── */
  parts.push('');
  parts.push('# 回复要求');
  parts.push('将你的回复放在以下标签内，标签之外不要输出任何内容。');
  parts.push(`<${RESP_TAG}>`);
  parts.push('你结合了相关信息后回复给用户的内容正文。仅需额外包裹此标签，回复本身与平时完全一致。');
  parts.push(`</${RESP_TAG}>`);

  // Info-control block (full only)
  if (mode === 'full') {
    parts.push(`<${INFO_CTRL_TAG}>`);
    parts.push('回复完成后，评估是否需要更新以下信息，更新会影响后续所有对话。');
    parts.push(`<${NEED_UPDATE_TAG}>`);
    parts.push('用户是否透露了关于自身的新信息，或纠正了已有信息？只关注持久性特征，忽略一次性的对话细节。');
    parts.push('只返回 true/false');
    parts.push(`</${NEED_UPDATE_TAG}>`);
    parts.push(`<${NEED_UPDATE_SOUL_TAG}>`);
    parts.push('你是否从用户的表达逻辑、语言风格、反馈、纠正或互动方式等信号中，观察到值得自己记住的互动或沟通模式？只提炼行为模式，不记录具体事件。');
    parts.push('只返回 true/false');
    parts.push(`</${NEED_UPDATE_SOUL_TAG}>`);
    parts.push('<!-- 以下标签仅在对应判断为 true 时输出，为 false 则跳过。 -->');
    parts.push(`<${UPDATED_BIO_TAG}>`);
    parts.push('重写完整 user-bio。保留已有信息，最小增量变更，删除过时项，合并重复项。');
    parts.push('用分行短句，每行一个维度。');
    parts.push('内容包括但不限于：姓名、昵称、年龄、性别、职业、社会关系等一切长期或静态特征。');
    parts.push(`</${UPDATED_BIO_TAG}>`);
    parts.push(`<${UPDATED_SOUL_TAG}>`);
    parts.push('重写完整 ai-soul。');
    parts.push('保留用户原始设定不动，仅追加从交互中习得的模式。');
    parts.push('最小增量变更，删除过时项，合并重复项。目标是让你能更好的理解用户，并以更符合用户期望的方式互动和回应。');
    parts.push('用分行短句，每行一个维度。');
    parts.push(`</${UPDATED_SOUL_TAG}>`);
    parts.push(`</${INFO_CTRL_TAG}>`);
  }

  parts.push(`</${MAIN_TAG}>`);

  parts.push(`<${USER_INPUT_TAG}>`);
  parts.push(userInput);
  parts.push(`</${USER_INPUT_TAG}>`);

  return parts.join('\n');
}

/**
 * Lightweight injection: only prepend current datetime to the user's input.
 * Used when mode is 'time' or as fallback when platform doesn't know time.
 */
export function formatTimeOnlyInjection(userInput: string): string {
  return `<current-date-time>${currentDateTime()}</current-date-time>\n${userInput}`;
}
