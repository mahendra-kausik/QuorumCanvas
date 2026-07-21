import { timingSafeEqual } from 'crypto';
import type { Stroke } from './types.js';
import { GATEWAY_SECURITY } from './config.js';

// L6: constant-time token compare — avoids leaking token length/prefix via response timing.
// `expected === null` means auth is disabled (AUTH_TOKEN unset); any provided value passes.
export function tokensMatch(provided: string | null | undefined, expected: string | null): boolean {
  if (expected === null) return true;
  if (!provided || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const STROKE_ACTIONS = new Set(['stroke', 'undo_stroke', 'redo_stroke']);

// L6: shape/bounds validation plus identity binding — a stroke must claim the boardId/userId
// of the connection that sent it, closing cross-board/identity forgery (a connection joined to
// board A submitting a write attributed to board B or another user).
export function validateStroke(
  stroke: unknown,
  conn: { boardId: string; userId: string },
): { ok: true } | { ok: false; reason: string } {
  if (!stroke || typeof stroke !== 'object') return { ok: false, reason: 'Stroke must be an object' };
  const s = stroke as Partial<Stroke> & Record<string, unknown>;

  if (typeof s.id !== 'string' || s.id.length === 0 || s.id.length > 200) {
    return { ok: false, reason: 'Invalid stroke id' };
  }
  if (s.boardId !== conn.boardId || s.userId !== conn.userId) {
    return { ok: false, reason: 'Stroke boardId/userId must match connection' };
  }
  if (s.action !== undefined && !STROKE_ACTIONS.has(s.action as string)) {
    return { ok: false, reason: 'Invalid stroke action' };
  }
  if (s.targetStrokeId !== undefined && typeof s.targetStrokeId !== 'string') {
    return { ok: false, reason: 'Invalid targetStrokeId' };
  }
  const action = s.action ?? 'stroke';
  const isUndoRedo = action === 'undo_stroke' || action === 'redo_stroke';
  if (isUndoRedo && typeof s.targetStrokeId !== 'string') {
    return { ok: false, reason: 'undo_stroke/redo_stroke requires targetStrokeId' };
  }

  if (typeof s.color !== 'string' || !HEX_COLOR.test(s.color)) {
    return { ok: false, reason: 'Invalid stroke color' };
  }
  if (typeof s.timestamp !== 'number' || !Number.isFinite(s.timestamp)) {
    return { ok: false, reason: 'Invalid stroke timestamp' };
  }

  // undo_stroke/redo_stroke carry no drawing data (width 0, points []) — they're pointers to
  // a prior stroke's id, not strokes themselves, so the shape checks below don't apply.
  if (isUndoRedo) {
    return { ok: true };
  }

  if (typeof s.width !== 'number' || !Number.isFinite(s.width) || s.width <= 0 || s.width > 100) {
    return { ok: false, reason: 'Invalid stroke width' };
  }
  if (!Array.isArray(s.points) || s.points.length === 0 || s.points.length > GATEWAY_SECURITY.maxStrokePoints) {
    return { ok: false, reason: 'Invalid stroke points' };
  }
  for (const point of s.points) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return { ok: false, reason: 'Invalid stroke point' };
    }
  }

  return { ok: true };
}
