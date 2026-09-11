import type { DiscoClient, User } from '@disco-live/client';
import type { AgenticToolOption } from '../../types';
import type { WorkspaceTeammateCreateInput } from '../WorkspaceShell/WorkspaceTeammateCreateModal';

export interface HomePageProps {
  client: DiscoClient | null;
  connected?: boolean;
  currentUser?: User | null;
  availableAgents?: AgenticToolOption[];
  creating?: boolean;
  mobileMinimal?: boolean;
  onSessionClick: (sessionId: string) => void;
  onNewSession: () => void;
  onCreateTeammate?: (input: WorkspaceTeammateCreateInput) => Promise<void>;
}
