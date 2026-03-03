import { STORE } from './constants';

/* ══════════════════════════════════════════
 *  Growth Entry — a single bio/soul update record
 * ══════════════════════════════════════════ */

export type GrowthField = 'bio' | 'soul';
export type GrowthSource = 'init' | 'user' | 'auto';

export interface GrowthEntry {
  ts: number;           // Unix ms
  field: GrowthField;
  slotId: string;       // stable identity.id or persona.id
  before: string;       // full text before update
  after: string;        // full text after update
  source: GrowthSource; // init | user | auto
}

/** Max entries per (slotId, field) combo — excluding init */
const MAX_PER_SLOT_FIELD = 50;

/* ══════════════════════════════════════════
 *  Storage helpers
 * ══════════════════════════════════════════ */

export async function loadGrowthLog(): Promise<GrowthEntry[]> {
  const data = await browser.storage.local.get(STORE.GROWTH_LOG);
  return (data[STORE.GROWTH_LOG] as GrowthEntry[] | undefined) ?? [];
}

async function saveGrowthLog(log: GrowthEntry[]): Promise<void> {
  await browser.storage.local.set({ [STORE.GROWTH_LOG]: log });
}

/**
 * Append a growth entry and enforce FIFO cap.
 * Init entries are never evicted.
 */
export async function appendGrowth(entry: GrowthEntry): Promise<void> {
  // Skip if content didn't actually change
  if (entry.before === entry.after) return;

  const log = await loadGrowthLog();
  log.push(entry);

  // Enforce cap per (slotId, field) — keep init, FIFO the rest
  const key = `${entry.slotId}:${entry.field}`;
  const indices: number[] = [];
  for (let i = 0; i < log.length; i++) {
    if (`${log[i].slotId}:${log[i].field}` === key && log[i].source !== 'init') {
      indices.push(i);
    }
  }
  if (indices.length > MAX_PER_SLOT_FIELD) {
    const removeCount = indices.length - MAX_PER_SLOT_FIELD;
    const toRemove = new Set(indices.slice(0, removeCount));
    const pruned = log.filter((_, i) => !toRemove.has(i));
    await saveGrowthLog(pruned);
  } else {
    await saveGrowthLog(log);
  }
}

/** Remove all growth entries for a given slot */
export async function clearSlotGrowth(slotId: string): Promise<void> {
  const log = await loadGrowthLog();
  const pruned = log.filter(e => e.slotId !== slotId);
  if (pruned.length !== log.length) await saveGrowthLog(pruned);
}

/**
 * Get history for a specific (slotId, field), newest first.
 */
export function getSlotHistory(log: GrowthEntry[], slotId: string, field: GrowthField): GrowthEntry[] {
  return log
    .filter(e => e.slotId === slotId && e.field === field)
    .sort((a, b) => {
      // init always first (pinned top)
      if (a.source === 'init' && b.source !== 'init') return -1;
      if (b.source === 'init' && a.source !== 'init') return 1;
      // then newest first
      return b.ts - a.ts;
    });
}

/* ══════════════════════════════════════════
 *  Line-level diff — simple, no dependencies
 * ══════════════════════════════════════════ */

export interface DiffLine {
  type: 'add' | 'del' | 'eq';
  text: string;
}

/**
 * Compute line-level diff between two texts.
 * Uses a simple LCS-based approach — good enough for short bios/souls.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  // LCS table
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ type: 'eq', text: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'add', text: b[j - 1] });
      j--;
    } else {
      result.push({ type: 'del', text: a[i - 1] });
      i--;
    }
  }
  return result.reverse();
}

/**
 * Format a timestamp for display: "3月2日 20:15"
 */
export function formatTs(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
