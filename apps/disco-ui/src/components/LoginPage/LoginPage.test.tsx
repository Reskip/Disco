import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { theme } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../../contexts/LocaleContext';
import { withAlpha } from '../GlassSurface/glassStyles';
import { LoginPage } from './LoginPage';

describe('LoginPage local username sign-in', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
    window.localStorage.clear();
  });
  it('keeps the local login form as the default when no redirect is configured', () => {
    const { container } = render(<LoginPage onLogin={vi.fn()} />);

    expect(screen.getByPlaceholderText('Username')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /京ICP备2026058667号/ })).toHaveAttribute(
      'href',
      'https://beian.miit.gov.cn/'
    );
    expect(screen.getByText('Personal service center for AI agents')).toBeInTheDocument();
    expect(container.querySelector('[data-gradient-backdrop="page"]')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
    expect(container.firstElementChild).toHaveStyle({ boxSizing: 'border-box' });
    expect(container.querySelector('.ant-card')?.getAttribute('style')).toContain(
      `background: ${withAlpha(theme.getDesignToken().colorBgContainer, 0.82)}`
    );
    expect(container.querySelector('[data-glass-highlights="subtle"]')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
    expect(screen.queryByText(/tsparticles/i)).not.toBeInTheDocument();
  });

  it('does not show first-time admin setup guidance on the local login form', () => {
    render(<LoginPage onLogin={vi.fn()} />);

    expect(screen.queryByText(/First-time server setup/)).not.toBeInTheDocument();
    expect(screen.queryByText('disco user create-admin')).not.toBeInTheDocument();
  });

  it('renders local login failures without any external redirect action', () => {
    render(<LoginPage onLogin={vi.fn()} error="Invalid username or password" />);

    expect(screen.getByText('Login Failed')).toBeInTheDocument();
    expect(screen.getByText('Invalid username or password')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('uses the personal service center slogan in Chinese', () => {
    window.localStorage.setItem('disco:locale', 'zh-CN');
    render(
      <LocaleProvider>
        <LoginPage onLogin={vi.fn()} />
      </LocaleProvider>
    );

    expect(screen.getByText('面向 AI 智能体的个人服务中心')).toBeInTheDocument();
  });

  it('accepts and normalizes a local username', async () => {
    const onLogin = vi.fn().mockResolvedValue(true);
    render(<LoginPage onLogin={onLogin} />);

    fireEvent.change(screen.getByPlaceholderText('Username'), {
      target: { value: ' FamilyUser ' },
    });
    fireEvent.change(screen.getByPlaceholderText('Password'), {
      target: { value: 'password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('familyuser', 'password-123'));
  });
});
