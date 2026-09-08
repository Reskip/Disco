import type { DiscoClient, UpdateUserInput, User } from '@disco-live/client';
import { WorkspaceSettingsModal } from '../components/WorkspaceShell';

export interface SharedUserSettingsModalProps {
  open: boolean;
  user: User | null;
  client: DiscoClient | null;
  onClose: () => void;
  onUpdateUser: (userId: string, updates: UpdateUserInput) => Promise<void>;
  onRefreshCurrentUser: () => Promise<unknown>;
}

/**
 * Shared-surface owner for current-user settings.
 *
 * Lightweight surfaces reuse the conversation product's settings UI without
 * importing the retired board/branch settings stack.
 */
export const SharedUserSettingsModal: React.FC<SharedUserSettingsModalProps> = ({
  open,
  user,
  client,
  onClose,
  onUpdateUser,
  onRefreshCurrentUser,
}) => (
  <WorkspaceSettingsModal
    open={open}
    onClose={onClose}
    currentUser={user}
    users={user ? [user] : []}
    client={client}
    onUpdateUser={async (userId, updates) => {
      await onUpdateUser(userId, updates);
      await onRefreshCurrentUser();
    }}
  />
);
