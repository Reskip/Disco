import { Flex, Spin, Typography, theme } from 'antd';
import type { LoadItem, LoadingStage } from '../hooks/useConversationData';
import type { LoaderPhase } from '../hooks/useInitialLoaderPhase';

interface Props {
  phase?: LoaderPhase;
  connecting?: boolean;
  loadingStage?: LoadingStage;
  items?: LoadItem[];
  message?: string;
}

export function InitialLoadingScreen({
  phase = 'loading',
  connecting = false,
  loadingStage = 'fetching',
  items = [],
  message,
}: Props) {
  const { token } = theme.useToken();
  const statusMessage =
    message ??
    (connecting
      ? '正在连接本地服务…'
      : loadingStage === 'indexing'
        ? '正在整理工作区数据…'
        : '正在加载工作区…');
  const completedItems = items.filter((item) => item.done).length;

  return (
    <Flex
      vertical
      align="center"
      justify="center"
      style={{
        minHeight: '100vh',
        backgroundColor: token.colorBgLayout,
        opacity: phase === 'fading' ? 0 : 1,
        transition: 'opacity 280ms ease-out',
      }}
    >
      <Spin size="large" />
      <Typography.Text type="secondary" style={{ marginTop: token.marginMD }}>
        {statusMessage}
      </Typography.Text>
      {!connecting && items.length > 0 && (
        <Typography.Text type="secondary" style={{ marginTop: token.marginXS, opacity: 0.72 }}>
          已完成 {completedItems}/{items.length}
        </Typography.Text>
      )}
    </Flex>
  );
}
