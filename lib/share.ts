import type { AIPersona } from './profile';

/**
 * 潜忆匙 — AI persona share code
 *
 * Encoding: JSON → DeflateRaw → URL-safe Base64
 *
 * Format history (decode supports all):
 *   v2  qys://  URL-safe Base64 compressed (current)
 *   v1  qys://  plain Base64 (legacy)
 */

const PREFIX = 'qys://';

/* ── Compression (DeflateRaw via CompressionStream) ── */

async function compress(input: string): Promise<Uint8Array> {
  const blob = new Blob([new TextEncoder().encode(input)]);
  const stream = blob.stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompress(data: Uint8Array): Promise<string> {
  const blob = new Blob([data]);
  const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/* ── URL-safe Base64 ── */

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') +
    '=='.slice(0, (4 - (str.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ── Public API ── */

/** Encode persona → 潜忆匙 (deflate + URL-safe Base64) */
export async function encodePersona(persona: AIPersona): Promise<string> {
  const json = JSON.stringify({ n: persona.name, i: persona.identity, s: persona.soul });
  const compressed = await compress(json);
  return PREFIX + toBase64Url(compressed);
}

/** Decode 潜忆匙 → persona. Supports v2 (compressed) and v1 (plain Base64). */
export async function decodePersona(code: string): Promise<AIPersona | null> {
  try {
    const raw = code.trim();
    if (!raw.startsWith(PREFIX)) return null;
    const b64 = raw.slice(PREFIX.length);

    let json: string;
    try {
      json = await decompress(fromBase64Url(b64));
    } catch {
      json = decodeURIComponent(escape(atob(b64)));
    }

    const obj = JSON.parse(json);
    if (typeof obj.n !== 'string' || typeof obj.s !== 'string') return null;
    const identity = typeof obj.i === 'string' ? obj.i
      : typeof obj.id === 'string' ? obj.id
      : typeof obj.b === 'string' ? obj.b : '';
    return { id: '', name: obj.n, identity, soul: obj.s };
  } catch {
    return null;
  }
}
