export const DISCO_AGENT_PROFILE_VERSION = 1 as const;

export interface DiscoAgentProfile {
  version: typeof DISCO_AGENT_PROFILE_VERSION;
  display_name: string;
  responsibilities_summary: string;
  documents: {
    identity: string;
    responsibilities: string;
    soul: string;
    user_preferences: string;
  };
  updated_at: string;
}

export interface DiscoAgentProfileSeed {
  displayName: string;
  responsibilities?: string | null;
  now?: string;
}

const normalizedMarkdown = (value: string): string => `${value.trim()}\n`;

export function createDefaultDiscoAgentProfile(seed: DiscoAgentProfileSeed): DiscoAgentProfile {
  const displayName = seed.displayName.trim() || '智能体';
  const responsibilities = seed.responsibilities?.trim() || '根据用户后续指示维护自己的长期职责。';
  return {
    version: DISCO_AGENT_PROFILE_VERSION,
    display_name: displayName,
    responsibilities_summary: responsibilities,
    documents: {
      identity: `# 身份\n\n- 名称：${displayName}\n- 类型：Disco 持久智能体\n`,
      responsibilities:
        `# 长期职责\n\n` +
        `<!-- disco:summary:start -->\n${responsibilities}\n<!-- disco:summary:end -->\n`,
      soul: '# 性格与原则\n\n保持清晰、可靠和主动；具体表达方式可由用户继续调整。\n',
      user_preferences: '# 用户偏好\n\n尚未记录。只保存跨会话有价值的稳定偏好。\n',
    },
    updated_at: seed.now ?? new Date().toISOString(),
  };
}

export function normalizeDiscoAgentProfile(
  value: unknown,
  seed: DiscoAgentProfileSeed
): DiscoAgentProfile {
  const fallback = createDefaultDiscoAgentProfile(seed);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const raw = value as Record<string, unknown>;
  const documents =
    raw.documents && typeof raw.documents === 'object' && !Array.isArray(raw.documents)
      ? (raw.documents as Record<string, unknown>)
      : {};
  const text = (candidate: unknown, fallbackValue: string) =>
    typeof candidate === 'string' && candidate.trim()
      ? normalizedMarkdown(candidate)
      : fallbackValue;
  return {
    version: DISCO_AGENT_PROFILE_VERSION,
    display_name:
      typeof raw.display_name === 'string' && raw.display_name.trim()
        ? raw.display_name.trim()
        : fallback.display_name,
    responsibilities_summary:
      typeof raw.responsibilities_summary === 'string' && raw.responsibilities_summary.trim()
        ? raw.responsibilities_summary.trim()
        : fallback.responsibilities_summary,
    documents: {
      identity: text(documents.identity, fallback.documents.identity),
      responsibilities: text(documents.responsibilities, fallback.documents.responsibilities),
      soul: text(documents.soul, fallback.documents.soul),
      user_preferences: text(documents.user_preferences, fallback.documents.user_preferences),
    },
    updated_at:
      typeof raw.updated_at === 'string' && raw.updated_at.trim()
        ? raw.updated_at
        : fallback.updated_at,
  };
}

export function reconcileDiscoAgentProfile(
  profile: DiscoAgentProfile,
  seed: DiscoAgentProfileSeed
): DiscoAgentProfile {
  const displayName = seed.displayName.trim() || profile.display_name;
  const responsibilities = seed.responsibilities?.trim() || profile.responsibilities_summary;
  const identity =
    displayName === profile.display_name
      ? profile.documents.identity.trim()
      : profile.documents.identity.replace(/(^-\s*名称：).*$/mu, `$1${displayName}`).trim();
  const responsibilityDocument = profile.documents.responsibilities.trim();
  const reconciledResponsibilities =
    responsibilities === profile.responsibilities_summary
      ? responsibilityDocument
      : /<!-- disco:summary:start -->[\s\S]*?<!-- disco:summary:end -->/u.test(
            responsibilityDocument
          )
        ? responsibilityDocument.replace(
            /<!-- disco:summary:start -->[\s\S]*?<!-- disco:summary:end -->/u,
            `<!-- disco:summary:start -->\n${responsibilities}\n<!-- disco:summary:end -->`
          )
        : `${responsibilityDocument}\n\n<!-- disco:summary:start -->\n${responsibilities}\n<!-- disco:summary:end -->`;
  const reconciled: DiscoAgentProfile = {
    ...profile,
    display_name: displayName,
    responsibilities_summary: responsibilities,
    documents: {
      ...profile.documents,
      identity: normalizedMarkdown(identity),
      responsibilities: normalizedMarkdown(reconciledResponsibilities),
    },
    updated_at: profile.updated_at,
  };
  const changed =
    reconciled.display_name !== profile.display_name ||
    reconciled.responsibilities_summary !== profile.responsibilities_summary ||
    reconciled.documents.identity !== profile.documents.identity ||
    reconciled.documents.responsibilities !== profile.documents.responsibilities;
  return changed ? { ...reconciled, updated_at: seed.now ?? new Date().toISOString() } : reconciled;
}

export function renderDiscoAgentInstructions(): string {
  return `# Disco 管理文件

本目录的智能体资料由 Disco 自动生成，请勿手动编辑。
`;
}

export function renderDiscoAgentProfileFiles(profile: DiscoAgentProfile): Record<string, string> {
  return {
    'AGENTS.md': renderDiscoAgentInstructions(),
    '.disco/IDENTITY.md': normalizedMarkdown(profile.documents.identity),
    '.disco/RESPONSIBILITIES.md': normalizedMarkdown(profile.documents.responsibilities),
    '.disco/SOUL.md': normalizedMarkdown(profile.documents.soul),
    '.disco/USER.md': normalizedMarkdown(profile.documents.user_preferences),
  };
}
