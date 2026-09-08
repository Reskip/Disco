/**
 * CompactionBlock - Renders compaction events (start + optional complete)
 *
 * Handles aggregation of compaction system messages:
 * - system_status (compacting) → Shows spinner
 * - system_complete (compaction) → Shows a compact completion marker
 *
 * Receives an array of messages (sorted chronologically):
 * - [start] → Spinner (in progress)
 * - [start, complete] → Completion UI with metadata
 */

import { CheckCircleOutlined } from '@ant-design/icons';
import type { Message } from '@disco-live/client';
import { Spin, Typography } from 'antd';
import type React from 'react';

const { Text } = Typography;

interface CompactionBlockProps {
  messages: Message[]; // Array of system messages (start, complete)
}

export const CompactionBlock: React.FC<CompactionBlockProps> = ({ messages }) => {
  const completeMessage = messages.find((m) => {
    if (!Array.isArray(m.content)) return false;
    return m.content.some(
      (b) => b.type === 'system_complete' && 'systemType' in b && b.systemType === 'compaction'
    );
  });

  // If we have complete message, show completion state
  if (completeMessage && Array.isArray(completeMessage.content)) {
    const completeBlock = completeMessage.content.find(
      (b) => b.type === 'system_complete' && 'systemType' in b && b.systemType === 'compaction'
    );

    if (completeBlock) {
      return (
        <div className="disco-compaction-status" role="status" aria-label="上下文已自动压缩">
          <CheckCircleOutlined aria-hidden />
          <Text type="secondary">上下文已自动压缩</Text>
        </div>
      );
    }
  }

  // Otherwise, show in-progress state (spinner)
  return (
    <div className="disco-compaction-status" role="status" aria-label="正在压缩上下文">
      <Spin size="small" />
      <Text type="secondary">正在压缩上下文…</Text>
    </div>
  );
};
