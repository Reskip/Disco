/**
 * Login Page Component
 *
 * Beautiful authentication page with Ant Design components
 */

import { LockOutlined, TranslationOutlined, UserOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Alert, Button, Divider, Dropdown, Form, Input, Space, Typography, theme } from 'antd';
import { useState } from 'react';
import { useLocale } from '../../contexts/LocaleContext';
import { isDarkTheme } from '../../utils/theme';
import { BrandLogo } from '../BrandLogo';
import { BrandMark } from '../BrandMark';
import { FilingNotice } from '../FilingNotice/FilingNotice';
import { GlassPanel } from '../GlassSurface/GlassPanel';
import { GradientBackdrop } from '../GradientBackdrop/GradientBackdrop';

const { Text } = Typography;

interface LoginPageProps {
  onLogin: (username: string, password: string) => Promise<boolean>;
  loading?: boolean;
  error?: string | null;
}

export function LoginPage({ onLogin, loading = false, error }: LoginPageProps) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const { token } = theme.useToken();
  const { locale, setLocale, t } = useLocale();
  const languageItems: MenuProps['items'] = [
    {
      key: 'zh-CN',
      label: t('simplifiedChinese'),
      disabled: locale === 'zh-CN',
      onClick: () => setLocale('zh-CN'),
    },
    {
      key: 'en-US',
      label: t('english'),
      disabled: locale === 'en-US',
      onClick: () => setLocale('en-US'),
    },
  ];

  const handleSubmit = async (values: { username: string; password: string }) => {
    setSubmitting(true);
    try {
      await onLogin(values.username.trim().toLowerCase(), values.password);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="disco-login-page"
      style={{
        minHeight: 'var(--disco-visible-viewport-height, 100dvh)',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: token.colorBgLayout,
        padding: 'clamp(12px, 3vw, 24px)',
        boxSizing: 'border-box',
        position: 'relative',
        overflow: 'auto',
      }}
    >
      <GradientBackdrop />

      <Dropdown menu={{ items: languageItems }} placement="bottomRight" trigger={['click']}>
        <Button
          className="disco-login-language"
          type="text"
          icon={<TranslationOutlined />}
          aria-label={t('language')}
          style={{ position: 'absolute', top: 16, right: 16, zIndex: 2 }}
        >
          {locale === 'zh-CN' ? t('simplifiedChinese') : t('english')}
        </Button>
      </Dropdown>

      <GlassPanel
        className="disco-login-card"
        surfaceAlpha={isDarkTheme(token) ? 0.68 : 0.82}
        highlights={{ intensity: 'subtle' }}
        style={{
          width: '100%',
          maxWidth: 420,
          borderRadius: token.borderRadiusLG,
          boxShadow: token.boxShadowSecondary,
          border: `1px solid ${token.colorBorderSecondary}`,
          zIndex: 1,
          margin: 'auto',
        }}
        variant="borderless"
      >
        {/* Header */}
        <Space orientation="vertical" size="large" style={{ width: '100%', marginBottom: 24 }}>
          <div style={{ textAlign: 'center' }}>
            <BrandMark size={72} style={{ margin: '0 auto 16px' }} />
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
              <BrandLogo level={1} />
            </div>
            <div>
              <Text type="secondary">{t('loginTagline')}</Text>
            </div>
            <Divider style={{ margin: '16px 0 0 0' }} />
          </div>
        </Space>

        {/* Error Alert */}
        {error && (
          <Alert
            type="error"
            title={t('loginFailed')}
            description={error}
            showIcon
            closable
            style={{ marginBottom: 24 }}
          />
        )}

        {/* Login Form */}
        <Form
          className="disco-login-form"
          form={form}
          name="login"
          layout="vertical"
          onFinish={handleSubmit}
          autoComplete="off"
        >
          <Form.Item
            name="username"
            rules={[
              { required: true, message: t('usernameRequired') },
              {
                transform: (value: unknown) => (typeof value === 'string' ? value.trim() : value),
                pattern: /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]{1,63}$/u,
                message: t('usernameInvalid'),
              },
            ]}
          >
            <Input
              prefix={<UserOutlined style={{ color: token.colorTextQuaternary }} />}
              placeholder={t('username')}
              autoComplete="username"
              maxLength={64}
            />
          </Form.Item>

          <Form.Item name="password" rules={[{ required: true, message: t('passwordRequired') }]}>
            <Input.Password
              prefix={<LockOutlined style={{ color: token.colorTextQuaternary }} />}
              placeholder={t('password')}
              autoComplete="current-password"
            />
          </Form.Item>

          <Form.Item style={{ marginBottom: 8 }}>
            <Button type="primary" htmlType="submit" loading={submitting || loading} block>
              {t('signIn')}
            </Button>
          </Form.Item>
        </Form>
      </GlassPanel>
      <FilingNotice className="disco-login-filing-footer" />
    </div>
  );
}
