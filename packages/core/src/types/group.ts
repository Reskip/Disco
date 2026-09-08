import type { GroupID, UserID } from './id';

export interface Group {
  group_id: GroupID;
  name: string;
  slug: string;
  description?: string;
  archived: boolean;
  created_by?: UserID;
  created_at: string;
  updated_at: string;
}

export interface GroupMembership {
  group_id: GroupID;
  user_id: UserID;
  added_by?: UserID;
  created_at: string;
}
