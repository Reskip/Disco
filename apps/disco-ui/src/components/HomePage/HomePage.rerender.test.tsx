import type { Session, User } from '@disco-live/client';
import { act, render, waitFor } from '@testing-library/react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/discoMaps';
import { discoStore } from '../../store/discoStore';
import { HomePage } from './HomePage';

// This always-rendered child is a faithful counter for HomePage renders while
// keeping the test independent of dashboard network requests and Ant Design.
let homeRenders = 0;

vi.mock('./HomeTokenUsageCard', () => ({
  HomeTokenUsageCard: () => {
    homeRenders += 1;
    return null;
  },
}));
vi.mock('./HomeProjectsSection', () => ({
  HomeProjectsSection: () => null,
}));
vi.mock('./HomeSessionsSection', () => ({
  HomeSessionsSection: () => null,
}));

const user = {
  user_id: 'u1',
  name: 'Alice',
  email: 'alice@example.com',
} as unknown as User;

const session = {
  session_id: 'session-1',
  status: 'completed',
  archived: false,
  genealogy: {},
  agentic_tool: 'codex',
  last_updated: '2026-07-01T10:00:00.000Z',
} as unknown as Session;

const noop = () => {};
const STABLE_HOME_PROPS = {
  client: null,
  connected: true,
  currentUser: user,
  onSessionClick: noop,
  onNewSession: noop,
  onOpenSettings: noop,
} as const;

function renderHome() {
  return render(
    <MemoryRouter basename="/ui" initialEntries={['/ui/']}>
      <HomePage {...STABLE_HOME_PROPS} />
    </MemoryRouter>
  );
}

describe('HomePage store-selector re-render isolation', () => {
  beforeEach(() => {
    homeRenders = 0;
    discoStore.setState({ ...EMPTY_MAPS });
  });

  it('a patch to an unselected slice leaves HomePage un-rendered', async () => {
    renderHome();
    await waitFor(() => expect(homeRenders).toBeGreaterThanOrEqual(1));
    const baseline = homeRenders;

    act(() => {
      discoStore.setState({ commentById: new Map([['c-1', { board_id: 'board-1' } as never]]) });
    });

    expect(homeRenders).toBe(baseline);
  });

  it('a session patch does not re-render the page shell', async () => {
    discoStore.setState({ sessionById: new Map([[session.session_id, session]]) });
    renderHome();
    await waitFor(() => expect(homeRenders).toBeGreaterThanOrEqual(1));
    const baseline = homeRenders;

    act(() => {
      discoStore.setState({
        sessionById: new Map([
          [session.session_id, { ...session, description: 'streamed token' } as Session],
        ]),
      });
    });

    expect(homeRenders).toBe(baseline);
  });

  it('user-directory hydration does not re-render the authenticated home greeting', async () => {
    renderHome();
    await waitFor(() => expect(homeRenders).toBeGreaterThanOrEqual(1));
    const baseline = homeRenders;

    act(() => {
      discoStore.setState({ userById: new Map([[user.user_id, user]]) });
    });

    expect(homeRenders).toBe(baseline);
  });
});

function useStableCallback<TFn extends (...args: never[]) => unknown>(
  callback: TFn | undefined
): TFn | undefined {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });
  const stable = useCallback(((...args: never[]) => callbackRef.current?.(...args)) as TFn, []);
  return callback ? stable : undefined;
}

let triggerParentRerender: () => void = () => {};

function ParentHarness({ stabilize }: { stabilize: boolean }) {
  const [, setTick] = useState(0);
  triggerParentRerender = () => setTick((tick) => tick + 1);
  const sessionImpl = () => {};
  const stableSession = useStableCallback(sessionImpl);

  return (
    <MemoryRouter basename="/ui" initialEntries={['/ui/']}>
      <HomePage {...STABLE_HOME_PROPS} onSessionClick={stabilize ? stableSession! : sessionImpl} />
    </MemoryRouter>
  );
}

describe('HomePage memo + prop-stabilization re-render bailout', () => {
  beforeEach(() => {
    homeRenders = 0;
    triggerParentRerender = () => {};
    discoStore.setState({ ...EMPTY_MAPS });
  });

  it('a parent re-render does not re-render HomePage when props are stable', async () => {
    render(<ParentHarness stabilize />);
    await waitFor(() => expect(homeRenders).toBeGreaterThanOrEqual(1));
    const baseline = homeRenders;

    act(() => triggerParentRerender());

    expect(homeRenders).toBe(baseline);
  });

  it('a parent re-render does re-render HomePage when a prop identity churns', async () => {
    render(<ParentHarness stabilize={false} />);
    await waitFor(() => expect(homeRenders).toBeGreaterThanOrEqual(1));
    const baseline = homeRenders;

    act(() => triggerParentRerender());

    await waitFor(() => expect(homeRenders).toBeGreaterThan(baseline));
  });
});
