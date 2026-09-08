import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../../contexts/LocaleContext';
import { EMPTY_MAPS } from '../../store/discoMaps';
import { discoStore } from '../../store/discoStore';
import { HomePage } from './HomePage';

vi.mock('./HomeTokenUsageCard', () => ({
  HomeTokenUsageCard: () => <div data-testid="token-dashboard">Token dashboard</div>,
}));

describe('HomePage mobile simplification', () => {
  beforeEach(() => discoStore.setState({ ...EMPTY_MAPS }));

  it('keeps the home dashboard while hiding mobile-only management actions', () => {
    const onNewSession = vi.fn();
    render(
      <MemoryRouter basename="/ui" initialEntries={['/ui/']}>
        <LocaleProvider>
          <HomePage
            client={null}
            connected
            currentUserId="user-1"
            mobileMinimal
            onSessionClick={() => {}}
            onNewSession={onNewSession}
            onOpenSettings={() => {}}
            onCreateTeammate={vi.fn()}
          />
        </LocaleProvider>
      </MemoryRouter>
    );

    expect(screen.queryByText('新建智能体')).not.toBeInTheDocument();
    expect(screen.getByTestId('token-dashboard')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /京ICP备2026058667号/ })).toHaveAttribute(
      'href',
      'https://beian.miit.gov.cn/'
    );
    fireEvent.click(screen.getByRole('button', { name: /新建独立对话/ }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });
});
