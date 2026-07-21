import { describe, it, expect } from 'vitest';
import { tokensMatch, validateStroke } from '../../gateway/src/security.js';
import type { Stroke } from '../../gateway/src/types.js';

function makeStroke(overrides: Partial<Stroke> = {}): Stroke {
  return {
    id: 'stroke-1',
    boardId: 'board-1',
    userId: 'user-1',
    color: '#E74C3C',
    width: 3,
    points: [[0, 0], [10, 10]],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('tokensMatch', () => {
  it('allows anything when expected is null (auth disabled)', () => {
    expect(tokensMatch(null, null)).toBe(true);
    expect(tokensMatch('anything', null)).toBe(true);
  });

  it('rejects a missing token when auth is enabled', () => {
    expect(tokensMatch(null, 'secret')).toBe(false);
    expect(tokensMatch(undefined, 'secret')).toBe(false);
  });

  it('rejects a length mismatch without throwing', () => {
    expect(tokensMatch('short', 'much-longer-secret')).toBe(false);
  });

  it('accepts an exact match', () => {
    expect(tokensMatch('secret', 'secret')).toBe(true);
  });

  it('rejects a same-length wrong value', () => {
    expect(tokensMatch('aaaaaa', 'bbbbbb')).toBe(false);
  });
});

describe('validateStroke', () => {
  const conn = { boardId: 'board-1', userId: 'user-1' };

  it('accepts a well-formed stroke', () => {
    expect(validateStroke(makeStroke(), conn)).toEqual({ ok: true });
  });

  it('rejects a non-object', () => {
    expect(validateStroke(null, conn).ok).toBe(false);
    expect(validateStroke('nope', conn).ok).toBe(false);
  });

  it('rejects a boardId/userId mismatch (identity forgery)', () => {
    expect(validateStroke(makeStroke({ boardId: 'other' }), conn).ok).toBe(false);
    expect(validateStroke(makeStroke({ userId: 'other' }), conn).ok).toBe(false);
  });

  it('rejects an invalid color', () => {
    expect(validateStroke(makeStroke({ color: 'red' }), conn).ok).toBe(false);
  });

  it('rejects a non-finite width', () => {
    expect(validateStroke(makeStroke({ width: NaN }), conn).ok).toBe(false);
    expect(validateStroke(makeStroke({ width: -1 }), conn).ok).toBe(false);
  });

  it('rejects points over the cap', () => {
    const points = Array.from({ length: 2001 }, () => [0, 0] as [number, number]);
    expect(validateStroke(makeStroke({ points }), conn).ok).toBe(false);
  });

  it('rejects a malformed point', () => {
    const points = [[0, 0], ['a', 1]] as unknown as [number, number][];
    expect(validateStroke(makeStroke({ points }), conn).ok).toBe(false);
  });

  it('rejects an invalid action', () => {
    expect(validateStroke({ ...makeStroke(), action: 'delete_everything' }, conn).ok).toBe(false);
  });

  it('accepts an undo_stroke event despite width:0 and empty points', () => {
    const undoEvent = makeStroke({ action: 'undo_stroke', targetStrokeId: 'stroke-1', width: 0, points: [] });
    expect(validateStroke(undoEvent, conn)).toEqual({ ok: true });
  });

  it('accepts a redo_stroke event despite width:0 and empty points', () => {
    const redoEvent = makeStroke({ action: 'redo_stroke', targetStrokeId: 'stroke-1', width: 0, points: [] });
    expect(validateStroke(redoEvent, conn)).toEqual({ ok: true });
  });

  it('rejects an undo_stroke/redo_stroke event missing targetStrokeId', () => {
    expect(validateStroke(makeStroke({ action: 'undo_stroke', width: 0, points: [] }), conn).ok).toBe(false);
  });
});
