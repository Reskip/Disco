import type { User } from '@disco-live/client';
import {
  LogoutOutlined,
  SoundOutlined,
  TranslationOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Button, Dropdown, Space, Tooltip, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { useLocale } from '../contexts/LocaleContext';
import { UserIdentityAvatar } from './UserIdentityAvatar';

export interface GlobalUserMenuProps {
  user?: User | null;
  disabled?: boolean;
  onUserSettingsClick?: () => void;
  onLogout?: () => void;
}

/**
 * Surface-agnostic current-user menu.
 *
 * This deliberately depends only on the current authenticated user and global
 * callbacks. It must not read workspace maps (`userById`, boards, sessions,
 * etc.) so lightweight secondary surfaces can show identity affordances
 * without starting the heavy Workspace store.
 */
export const GlobalUserMenu: React.FC<GlobalUserMenuProps> = ({
  user,
  disabled = false,
  onUserSettingsClick,
  onLogout,
}) => {
  const { token } = theme.useToken();
  const { locale, setLocale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const audioEnabled = user?.preferences?.audio?.enabled ?? false;

  const items: MenuProps['items'] = [
    {
      key: 'user-info',
      label: (
        <div style={{ padding: '4px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
          <UserIdentityAvatar user={user} size={32} />
          <div>
            <div style={{ fontWeight: 500 }}>{user?.name || t('user')}</div>
            <div style={{ fontSize: 12, color: token.colorTextDescription }}>{user?.username}</div>
          </div>
        </div>
      ),
      disabled: true,
    },
    { type: 'divider' },
    {
      key: 'user-settings',
      label: (
        <Space>
          <span>{t('userSettings')}</span>
          {audioEnabled && (
            <Tooltip title={t('audioNotificationsEnabled')}>
              <SoundOutlined style={{ color: token.colorSuccess, fontSize: 12 }} />
            </Tooltip>
          )}
        </Space>
      ),
      icon: <UserOutlined />,
      onClick: () => {
        setOpen(false);
        onUserSettingsClick?.();
      },
    },
    {
      key: 'language',
      label: t('language'),
      icon: <TranslationOutlined />,
      children: [
        {
          key: 'language-zh-CN',
          label: t('simplifiedChinese'),
          disabled: locale === 'zh-CN',
          onClick: () => setLocale('zh-CN'),
        },
        {
          key: 'language-en-US',
          label: t('english'),
          disabled: locale === 'en-US',
          onClick: () => setLocale('en-US'),
        },
      ],
    },
    {
      key: 'logout',
      label: t('logout'),
      icon: <LogoutOutlined />,
      onClick: () => {
        setOpen(false);
        onLogout?.();
      },
    },
  ];

  return (
    <Dropdown
      menu={{ items }}
      placement="bottomRight"
      trigger={['click']}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      <Tooltip title={user?.name || t('user')} placement="bottom">
        <Button
          type="text"
          icon={<UserOutlined style={{ fontSize: token.fontSizeLG }} />}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          disabled={disabled}
        />
      </Tooltip>
    </Dropdown>
  );
};
