import { MessageOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import { Button, Layout, Typography, theme } from 'antd';
import { memo, useState } from 'react';
import { useLocale } from '../../contexts/LocaleContext';
import { FilingNotice } from '../FilingNotice/FilingNotice';
import { WorkspaceTeammateCreateModal } from '../WorkspaceShell/WorkspaceTeammateCreateModal';
import { HomeTokenUsageCard } from './HomeTokenUsageCard';
import type { HomePageProps } from './types';
import { useDailyHomeGreeting } from './useDailyHomeGreeting';

const { Content } = Layout;

export const HomePage = memo(function HomePage(props: HomePageProps) {
  const { token } = theme.useToken();
  const { t } = useLocale();
  const [agentCreateOpen, setAgentCreateOpen] = useState(false);
  // Share the sidebar's resolved identity, available before directory hydration.
  const name = props.currentUser?.name || props.currentUser?.username || t('user');
  const [greeting, subtitle] = useDailyHomeGreeting(props.currentUser?.user_id, name);
  const workspaceReady = props.connected;

  return (
    <div
      className="disco-home-page"
      style={{ height: '100%', overflow: 'hidden', background: token.colorBgLayout }}
    >
      <Layout style={{ height: '100%', background: 'transparent' }}>
        <Content style={{ overflowY: 'auto' }}>
          <main
            className="disco-home-content"
            style={{
              display: 'flex',
              flexDirection: 'column',
              width: 'min(1180px, 100%)',
              minHeight: '100%',
              margin: '0 auto',
              padding: 'clamp(22px, 3vw, 38px) clamp(18px, 3vw, 38px) 52px',
            }}
          >
            <header
              className="disco-home-header"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 14,
                marginBottom: 'clamp(18px, 2.2vw, 26px)',
              }}
            >
              <div className="disco-home-intro">
                <Typography.Title
                  level={2}
                  style={{
                    margin: 0,
                    fontSize: 'clamp(23px, 2vw, 30px)',
                    letterSpacing: '-0.025em',
                    fontWeight: 650,
                  }}
                >
                  {greeting}
                </Typography.Title>
                <Typography.Text
                  type="secondary"
                  style={{ display: 'block', marginTop: 4, fontSize: 'clamp(13px, 1vw, 15px)' }}
                >
                  {subtitle}
                </Typography.Text>
              </div>
              <div
                className="disco-home-actions"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  justifyContent: 'flex-end',
                  gap: 8,
                }}
              >
                {!props.mobileMinimal && (
                  <Button
                    className="disco-home-action-button"
                    size="middle"
                    icon={<RobotOutlined />}
                    disabled={!workspaceReady || !props.onCreateTeammate}
                    onClick={() => setAgentCreateOpen(true)}
                    style={{ height: 36, paddingInline: 15, boxShadow: 'none' }}
                  >
                    新建智能体
                  </Button>
                )}
                <Button
                  className="disco-home-action-button"
                  size="middle"
                  icon={<PlusOutlined />}
                  disabled={props.creating || !workspaceReady}
                  onClick={() => props.onNewSession()}
                  style={{
                    height: 36,
                    paddingInline: 15,
                    boxShadow: 'none',
                  }}
                >
                  新建独立对话
                </Button>
              </div>
            </header>

            <HomeTokenUsageCard
              client={props.client}
              connected={props.connected}
              currentUserId={props.currentUser?.user_id}
            />

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                minHeight: 64,
                color: token.colorTextSecondary,
              }}
            >
              <MessageOutlined />
              <Typography.Text type="secondary">从左侧随时打开智能体或最近对话。</Typography.Text>
            </div>

            <FilingNotice className="disco-home-filing-footer" />
          </main>
        </Content>
      </Layout>
      {props.onCreateTeammate && (
        <WorkspaceTeammateCreateModal
          open={agentCreateOpen}
          onClose={() => setAgentCreateOpen(false)}
          onCreate={props.onCreateTeammate}
        />
      )}
    </div>
  );
});

export default HomePage;
