import qrcode from 'qrcode-generator';
import type { AIPersona } from './profile';
import { encodePersona, decodePersona } from './share';

/**
 * QR code generation & decoding for 潜忆匙.
 *
 * Strategy: QR stores the text share code (qys://...) directly.
 * - Encoding: reuse encodePersona → QR text content
 * - Decoding: jsQR result.data (text) → reuse decodePersona
 * This avoids all binary byte-encoding issues between QR libraries.
 */

/* ── QR generation ── */

/** QR Version 40 ECC-L can hold ~4296 alphanumeric chars. Safe limit for our Base64 codes. */
const QR_MAX_CHARS = 4000;

/**
 * Generate a share card image (data URL) with:
 *   - White rounded-rect card background
 *   - Title: "潜忆匙 · {persona name}"
 *   - QR code in center
 *   - Logo icon + slogan at bottom
 *
 * Returns null if content exceeds QR capacity.
 */
export async function generateQR(persona: AIPersona): Promise<string | null> {
  const code = await encodePersona(persona);
  if (code.length > QR_MAX_CHARS) return null;

  const qr = qrcode(0, 'L');
  qr.addData(code);
  qr.make();

  /* ── Layout constants ── */
  const moduleCount = qr.getModuleCount();

  // Limit QR to a fixed visual size; dynamically compute cellSize
  const QR_TARGET = 280;
  const cellSize = Math.max(2, Math.floor(QR_TARGET / moduleCount));
  const qrSize = moduleCount * cellSize;

  // Compact card layout — no logo, tight spacing
  const cardW = 380;
  const cardPadX = Math.floor((cardW - qrSize) / 2);
  const cardPadTop = 40;
  const titleGap = 20;     // gap between subtitle and QR
  const qrBottomGap = 20;  // gap between QR and slogan
  const cardPadBottom = 32;

  const titleH = 28;
  const subtitleH = 22;
  const sloganH = 22;
  const cardH = cardPadTop + titleH + subtitleH + titleGap + qrSize + qrBottomGap + sloganH + cardPadBottom;

  const canvasPad = 16;
  const W = cardW + canvasPad * 2;
  const H = cardH + canvasPad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  /* ── Card background (white, rounded) ── */
  const r = 24;
  const cx = canvasPad, cy = canvasPad;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(cx + r, cy);
  ctx.lineTo(cx + cardW - r, cy);
  ctx.quadraticCurveTo(cx + cardW, cy, cx + cardW, cy + r);
  ctx.lineTo(cx + cardW, cy + cardH - r);
  ctx.quadraticCurveTo(cx + cardW, cy + cardH, cx + cardW - r, cy + cardH);
  ctx.lineTo(cx + r, cy + cardH);
  ctx.quadraticCurveTo(cx, cy + cardH, cx, cy + cardH - r);
  ctx.lineTo(cx, cy + r);
  ctx.quadraticCurveTo(cx, cy, cx + r, cy);
  ctx.closePath();
  ctx.fill();

  // Subtle card shadow
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.08)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 4;
  ctx.fill();
  ctx.restore();

  /* ── Title ── */
  const name = persona.name || '未命名';
  let titleY = cy + cardPadTop;
  ctx.fillStyle = '#1a1a2e';
  ctx.font = 'bold 32px "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('潜忆匙', W / 2, titleY);
  // Persona name
  titleY += subtitleH + 6;
  ctx.fillStyle = '#888';
  ctx.font = '18px "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';
  ctx.fillText(`「${name}」`, W / 2, titleY);

  /* ── QR code ── */
  const qrX = cx + cardPadX;
  const qrY = titleY + titleGap;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(qrX - 8, qrY - 8, qrSize + 16, qrSize + 16);
  ctx.fillStyle = '#1a1a2e';
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(qrX + col * cellSize, qrY + row * cellSize, cellSize, cellSize);
      }
    }
  }

  /* ── Slogan ── */
  const sloganY = qrY + qrSize + qrBottomGap + sloganH / 2;
  ctx.fillStyle = '#aaa';
  ctx.font = '17px "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('潜忆 — 让 AI 记住你', W / 2, sloganY);

  return canvas.toDataURL('image/png');
}

/* ── QR decoding (lazy-loads jsQR on first call) ── */

async function imageToData(source: Blob | string): Promise<ImageData> {
  const blob = typeof source === 'string'
    ? await (await fetch(source)).blob()
    : source;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export async function decodeQR(source: Blob | string): Promise<AIPersona | null> {
  try {
    const { default: jsQR } = await import('jsqr');
    const imgData = await imageToData(source);
    const result = jsQR(imgData.data, imgData.width, imgData.height, {
      inversionAttempts: 'attemptBoth',
    });
    if (!result) {
      console.warn('⚠️ jsQR: no QR code found in image', imgData.width, 'x', imgData.height);
      return null;
    }
    // result.data is the text string from the QR code = our qys:// share code
    return await decodePersona(result.data);
  } catch (e) {
    console.warn('⚠️ decodeQR failed:', e);
    return null;
  }
}

export { QR_MAX_CHARS as QR_MAX_BYTES };
