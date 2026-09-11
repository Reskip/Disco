import type { Session } from '@disco-live/client';
import { describe, expect, it } from 'vitest';
import {
  buildById,
  buildSessionMaps,
  reconcileByIdMap,
  reconcileSessionSnapshot,
} from './discoMaps';

const makeSession = (id: string, status: Session['status'] = 'running'): Session =>
  ({
    session_id: id,
    status,
    archived: false,
    created_at: '2026-09-11T00:00:00.000Z',
    last_updated: '2026-09-11T00:00:00.000Z',
  }) as Session;

const makeRecord = (id: string, name = 'Original') => ({ id, name });

describe('reconcileByIdMap', () => {
  it('returns the prior map when nothing changed', () => {
    const previous = buildById([makeRecord('a'), makeRecord('b')], 'id');
    expect(reconcileByIdMap(previous, new Map(previous))).toBe(previous);
  });

  it('retains unchanged rows when another row changes', () => {
    const a = makeRecord('a');
    const b = makeRecord('b');
    const previous = buildById([a, b], 'id');
    const next = new Map([
      ['a', makeRecord('a')],
      ['b', makeRecord('b', 'Renamed')],
    ]);
    const result = reconcileByIdMap(previous, next);
    expect(result).not.toBe(previous);
    expect(result.get('a')).toBe(a);
    expect(result.get('b')).not.toBe(b);
    expect(result.get('b')?.name).toBe('Renamed');
  });

  it('treats added and removed keys as changes', () => {
    const previous = buildById([makeRecord('a')], 'id');
    expect(reconcileByIdMap(previous, new Map())).not.toBe(previous);
    expect(reconcileByIdMap(previous, new Map([...previous, ['c', makeRecord('c')]]))).not.toBe(
      previous
    );
  });
});

describe('buildSessionMaps reference stability', () => {
  it('reuses the session map after an identical refetch', () => {
    const previous = buildSessionMaps([makeSession('s1'), makeSession('s2')]);
    const rebuilt = buildSessionMaps([makeSession('s1'), makeSession('s2')], previous);
    expect(rebuilt.sessionById).toBe(previous.sessionById);
  });

  it('updates a changed session while preserving other row references', () => {
    const previous = buildSessionMaps([makeSession('s1'), makeSession('s2')]);
    const rebuilt = buildSessionMaps([makeSession('s1'), makeSession('s2', 'idle')], previous);
    expect(rebuilt.sessionById).not.toBe(previous.sessionById);
    expect(rebuilt.sessionById.get('s1')).toBe(previous.sessionById.get('s1'));
    expect(rebuilt.sessionById.get('s2')?.status).toBe('idle');
  });

  it('builds the current flat conversation index without a previous snapshot', () => {
    const session = makeSession('s1');
    const built = buildSessionMaps([session]);
    expect(built.sessionById.get('s1')).toBe(session);
    expect(built.sessionById.size).toBe(1);
  });
});

describe('reconcileSessionSnapshot', () => {
  it('keeps a completion received after the request began', () => {
    const running = makeSession('s1');
    const completed = { ...running, status: 'idle' as const, ready_for_prompt: true };
    const baseline = new Map([['s1', running]]);
    const current = new Map([['s1', completed]]);
    const result = reconcileSessionSnapshot([running], current, baseline, true);
    expect(result).toBe(current);
    expect(result.get('s1')).toBe(completed);
  });

  it('does not overwrite a newer run with an older completion response', () => {
    const completed = makeSession('s1', 'idle');
    const running = makeSession('s1');
    const baseline = new Map([['s1', completed]]);
    const current = new Map([['s1', running]]);
    expect(reconcileSessionSnapshot([completed], current, baseline).get('s1')).toBe(running);
  });

  it('retains unrelated sessions during a partial status refresh', () => {
    const current = new Map([
      ['s1', makeSession('s1')],
      ['s2', makeSession('s2')],
    ]);
    const result = reconcileSessionSnapshot([makeSession('s1', 'idle')], current, current);
    expect(result.get('s1')?.status).toBe('idle');
    expect(result.get('s2')).toBe(current.get('s2'));
  });

  it('evicts unchanged rows absent from an authoritative workspace snapshot', () => {
    const current = new Map([['old', makeSession('old')]]);
    const result = reconcileSessionSnapshot([makeSession('current')], current, current, true);
    expect(result.has('old')).toBe(false);
    expect(result.has('current')).toBe(true);
  });

  it('does not resurrect a session removed while a snapshot was in flight', () => {
    const removed = makeSession('removed');
    const baseline = new Map([['removed', removed]]);
    expect(reconcileSessionSnapshot([removed], new Map(), baseline, true).size).toBe(0);
  });
});
