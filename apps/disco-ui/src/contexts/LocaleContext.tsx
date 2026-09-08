import type { Locale } from 'antd/es/locale';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type AppLocale = 'en-US' | 'zh-CN';

const STORAGE_KEY = 'disco:locale';

const EN_MESSAGES = {
  language: 'Language',
  english: 'English',
  simplifiedChinese: '简体中文',
  user: 'User',
  userSettings: 'User Settings',
  logout: 'Logout',
  audioNotificationsEnabled: 'Audio notifications enabled',
  liveEvents: 'Live Events',
  documentation: 'Documentation',
  theme: 'Theme',
  settings: 'Settings',
  home: 'Home',
  goHome: 'Go to Home',
  loginTagline: 'Personal service center for AI agents',
  loginFailed: 'Login Failed',
  usernameRequired: 'Please enter your username',
  usernameInvalid: 'Use 2-64 letters, numbers, dots, underscores, or hyphens',
  username: 'Username',
  passwordRequired: 'Please enter your password',
  password: 'Password',
  signIn: 'Sign In',
  greeting: 'Hi, {name}! 👋',
  workspaceOverview: "Here's an overview of your workspace.",
  personalWorkspace: 'Your projects, conversations, and usage in one place.',
  projects: 'Projects',
  project: 'Project',
  newProject: 'New project',
  createProject: 'Create project',
  newSession: 'New session',
  startSession: 'Start session',
  chooseProject: 'Choose a project',
  chooseProjectHint:
    'Select where this conversation should work. You can change projects next time.',
  selectProject: 'Select a project',
  noProjectsYet: 'No projects yet',
  noProjectsHint: 'Add a local folder or clone a Git repository to start a conversation.',
  projectSessions: '{count} sessions',
  projectReady: 'Ready',
  projectPreparing: 'Preparing',
  projectFailed: 'Needs attention',
  projectLocal: 'Local folder',
  projectRemote: 'Git repository',
  projectName: 'Project name',
  localFolder: 'Local folder',
  remoteRepository: 'Git repository',
  localPath: 'Folder path',
  remoteUrl: 'Repository URL',
  projectNameRequired: 'Enter a project name',
  projectNameHint: 'Used in the project list and converted to a safe identifier automatically.',
  localPathRequired: 'Enter the absolute path to the project folder',
  remoteUrlRequired: 'Enter the Git repository URL',
  projectCreateFailed: 'Failed to create project',
  projectSessionPreparing: 'Preparing the project workspace…',
  projectSessionFailed: 'Could not prepare this project for a new session',
  recentSessions: 'Recent sessions',
  openProjectSettings: 'Manage projects',
  viewAll: 'View all',
  integrations: 'Integrations',
  accounts: 'Accounts',
  users: 'Users',
  agentTools: 'Agent tools',
  mcpServers: 'MCP servers',
  about: 'About',
  new: 'New',
  newAiTeammate: 'New agent',
  launchAiSession: 'Launch an AI session',
  configureMcpTools: 'Configure MCP tools',
  inviteTeammate: 'Invite a member',
  connectAction: 'Connect →',
  createAction: 'Create →',
  startAction: 'Start →',
  setupAction: 'Set up →',
  inviteAction: 'Invite →',
  getStarted: 'Get started with Disco',
  dontShowAgain: "Don't show again",
  teammatesActiveWeek: 'Agents active this week',
  sessionsRunningNow: 'Sessions running now',
  sessionsActiveWeek: 'Sessions active this week',
  teamWeekTooltip: '{mine} by you, {team} by the team',
  mySessions: 'My Sessions',
  sessions: 'Sessions',
  filterSessions: 'Filter sessions...',
  noMatchingSessions: 'No matching sessions',
  noSessionsYet: 'No sessions yet',
  activeCount: '{count} active',
  lastSession: 'Last session {time}',
  teamActivity: 'Team activity',
  all: 'All',
  teammates: 'Agents',
  noRecentActivity: 'No recent activity',
  search: 'Search...',
  jumpBackIn: 'Jump back in — {count} session(s) waiting for your reply',
  andMore: 'and {count} more',
  modalNewAiTeammate: 'New agent',
  cancel: 'Cancel',
  startAiTeammate: 'Start agent',
  aiTeammate: 'Agent',
  tokenUsage: 'Token usage',
  tokenUsageSubtitle: 'All-time usage for this Disco workspace',
  tokenUsageDashboardSubtitle: 'Usage history and near-real-time activity',
  todayTokens: 'Today',
  weekTokens: 'This week',
  allTimeTokens: 'All time',
  tokenHistory: 'Usage history',
  tokenHistoryHint: 'Daily token volume over the last {weeks} weeks',
  tokenUsageByModel: 'By model',
  realtimeActivity: 'Realtime activity',
  realtimeActivityHint: 'Last 24 hours · 10-minute display resolution · refreshes every 30 seconds',
  realtimeHourHint: 'Last 60 minutes · 30-second samples · refreshes every 30 seconds',
  less: 'Less',
  more: 'More',
  noActivity: 'No activity',
  live: 'Live',
  tasksAndUsers: '{tasks} tasks · {users} users',
  userShare: '{percent}% of total',
  totalTokens: 'Total tokens',
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  cacheTokens: 'Cache Token',
  estimatedCostCny: 'Estimated cost',
  tasks: 'Tasks',
  byUser: 'Usage by user',
  userRankingHint: 'Sorted by Token usage',
  noTokenUsage: 'No token usage has been recorded yet',
  tokenUsageLoadFailed: 'Failed to load token usage',
  refresh: 'Refresh',
  unknownUser: 'Unknown user',
  model: 'Model',
  effort: 'Effort',
  reasoningEffort: 'Reasoning effort',
  inherited: 'Inherited',
  effortLow: 'Low',
  effortMedium: 'Medium',
  effortHigh: 'High',
  effortXHigh: 'X-High',
  effortMax: 'Max',
  effortLowDescription: 'Minimal thinking, fastest responses',
  effortMediumDescription: 'Moderate thinking',
  effortHighDescription: 'Deep reasoning',
  effortXHighDescription: 'Extra reasoning depth, below maximum',
  effortMaxDescription: 'Highest effort level (model-dependent)',
  managedByPreset: 'Managed by preset. Switch presets in Session Settings.',
  moreOptions: 'More options',
  permissions: 'Permissions',
  tokens: 'tokens',
  stop: 'Stop',
  send: 'Send',
  attachFiles: 'Attach files',
  advancedUpload: 'Advanced upload',
  disconnected: 'Disconnected from daemon',
  forkSession: 'Fork Session',
  spawnSubsession: 'Spawn subsession',
  justNow: 'just now',
} as const;

export type TranslationKey = keyof typeof EN_MESSAGES;

const ZH_MESSAGES: Record<TranslationKey, string> = {
  language: '语言',
  english: 'English',
  simplifiedChinese: '简体中文',
  user: '用户',
  userSettings: '个人设置',
  logout: '退出登录',
  audioNotificationsEnabled: '已启用声音通知',
  liveEvents: '实时事件',
  documentation: '使用文档',
  theme: '主题',
  settings: '系统设置',
  home: '首页',
  goHome: '返回首页',
  loginTagline: '面向 AI 智能体的个人服务中心',
  loginFailed: '登录失败',
  usernameRequired: '请输入用户名',
  usernameInvalid: '用户名需为 2–64 位文字、数字、点、下划线或连字符',
  username: '用户名',
  passwordRequired: '请输入密码',
  password: '密码',
  signIn: '登录',
  greeting: '你好，{name}！👋',
  workspaceOverview: '这是你的工作区概览。',
  personalWorkspace: '项目、会话和用量，一处即可查看。',
  projects: '项目',
  project: '项目',
  newProject: '新建项目',
  createProject: '创建项目',
  newSession: '新建会话',
  startSession: '开始会话',
  chooseProject: '选择项目',
  chooseProjectHint: '选择本次会话使用的项目，下次新建时仍可更换。',
  selectProject: '请选择项目',
  noProjectsYet: '还没有项目',
  noProjectsHint: '添加本地文件夹或克隆 Git 仓库后即可开始会话。',
  projectSessions: '{count} 个会话',
  projectReady: '可用',
  projectPreparing: '准备中',
  projectFailed: '需要处理',
  projectLocal: '本地文件夹',
  projectRemote: 'Git 仓库',
  projectName: '项目名称',
  localFolder: '本地文件夹',
  remoteRepository: 'Git 仓库',
  localPath: '文件夹路径',
  remoteUrl: '仓库地址',
  projectNameRequired: '请输入项目名称',
  projectNameHint: '用于项目列表显示，并会自动转换为安全标识。',
  localPathRequired: '请输入项目文件夹的绝对路径',
  remoteUrlRequired: '请输入 Git 仓库地址',
  projectCreateFailed: '项目创建失败',
  projectSessionPreparing: '正在准备项目工作区…',
  projectSessionFailed: '无法为此项目准备新会话',
  recentSessions: '最近会话',
  openProjectSettings: '管理项目',
  viewAll: '查看全部',
  integrations: '集成',
  accounts: '账号',
  users: '用户管理',
  agentTools: '智能体工具',
  mcpServers: 'MCP 服务',
  about: '关于',
  new: '新建',
  newAiTeammate: '新建智能体',
  launchAiSession: '启动 AI 会话',
  configureMcpTools: '配置 MCP 工具',
  inviteTeammate: '邀请成员',
  connectAction: '连接 →',
  createAction: '创建 →',
  startAction: '启动 →',
  setupAction: '设置 →',
  inviteAction: '邀请 →',
  getStarted: '开始使用 Disco',
  dontShowAgain: '不再显示',
  teammatesActiveWeek: '本周活跃智能体',
  sessionsRunningNow: '当前运行会话',
  sessionsActiveWeek: '本周活跃会话',
  teamWeekTooltip: '你创建 {mine} 个，团队共 {team} 个',
  mySessions: '我的会话',
  sessions: '会话',
  filterSessions: '筛选会话…',
  noMatchingSessions: '没有匹配的会话',
  noSessionsYet: '还没有会话',
  activeCount: '{count} 个活跃',
  lastSession: '最近会话：{time}',
  teamActivity: '团队动态',
  all: '全部',
  teammates: '智能体',
  noRecentActivity: '暂无最近动态',
  search: '搜索…',
  jumpBackIn: '继续处理 — 有 {count} 个会话等待你的回复',
  andMore: '另有 {count} 个',
  modalNewAiTeammate: '新建智能体',
  cancel: '取消',
  startAiTeammate: '启动智能体',
  aiTeammate: '智能体',
  tokenUsage: 'Token 用量',
  tokenUsageSubtitle: '当前 Disco 工作区的累计用量',
  tokenUsageDashboardSubtitle: '历史用量与近实时活动',
  todayTokens: '今日用量',
  weekTokens: '本周用量',
  allTimeTokens: '累计用量',
  tokenHistory: '用量历史',
  tokenHistoryHint: '最近 {weeks} 周每日 Token 用量',
  tokenUsageByModel: '按模型统计',
  realtimeActivity: '实时活动',
  realtimeActivityHint: '最近 24 小时 · 约 10 分钟显示分辨率 · 每 30 秒刷新',
  realtimeHourHint: '最近 60 分钟 · 30 秒采样 · 每 30 秒刷新',
  less: '少',
  more: '多',
  noActivity: '暂无活动',
  live: '实时',
  tasksAndUsers: '{tasks} 个任务 · {users} 个用户',
  userShare: '占总量 {percent}%',
  totalTokens: 'Token 总量',
  inputTokens: '输入 Token',
  outputTokens: '输出 Token',
  cacheTokens: 'Cache Token',
  estimatedCostCny: '预估费用',
  tasks: '任务数',
  byUser: '按用户统计',
  userRankingHint: '按 Token 用量排序',
  noTokenUsage: '暂未记录 Token 用量',
  tokenUsageLoadFailed: 'Token 用量加载失败',
  refresh: '刷新',
  unknownUser: '未知用户',
  model: '模型',
  effort: '思考深度',
  reasoningEffort: '思考深度',
  inherited: '继承默认值',
  effortLow: '低',
  effortMedium: '中',
  effortHigh: '高',
  effortXHigh: '极高',
  effortMax: '最高',
  effortLowDescription: '最少思考，响应最快',
  effortMediumDescription: '适度思考，兼顾速度与质量',
  effortHighDescription: '深度思考',
  effortXHighDescription: '更深层推理，低于最高档',
  effortMaxDescription: '最高思考强度（取决于模型）',
  managedByPreset: '此项由预设管理，请在“会话设置”中切换预设。',
  moreOptions: '更多选项',
  permissions: '权限',
  tokens: 'Token',
  stop: '停止',
  send: '发送',
  attachFiles: '添加文件',
  advancedUpload: '高级上传',
  disconnected: '已断开与服务端的连接',
  forkSession: '派生会话',
  spawnSubsession: '创建子会话',
  justNow: '刚刚',
};

function interpolate(message: string, values?: Record<string, string | number>): string {
  if (!values) return message;
  return message.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match
  );
}

interface LocaleContextValue {
  locale: AppLocale;
  antdLocale: Locale;
  setLocale: (locale: AppLocale) => void;
  t: (key: TranslationKey, values?: Record<string, string | number>) => string;
}

const DEFAULT_VALUE: LocaleContextValue = {
  locale: 'en-US',
  antdLocale: enUS,
  setLocale: () => {},
  t: (key, values) => interpolate(EN_MESSAGES[key], values),
};

const LocaleContext = createContext<LocaleContextValue>(DEFAULT_VALUE);

function readStoredLocale(): AppLocale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en-US' || stored === 'zh-CN') return stored;
  } catch {
    // Storage may be unavailable in privacy-restricted browsers.
  }
  return 'zh-CN';
}

export const LocaleProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<AppLocale>(readStoredLocale);

  const setLocale = useCallback((nextLocale: AppLocale) => {
    setLocaleState(nextLocale);
    try {
      localStorage.setItem(STORAGE_KEY, nextLocale);
    } catch {
      // The in-memory selection still works for this tab.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback(
    (key: TranslationKey, values?: Record<string, string | number>) => {
      const messages = locale === 'zh-CN' ? ZH_MESSAGES : EN_MESSAGES;
      return interpolate(messages[key], values);
    },
    [locale]
  );

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t, antdLocale: locale === 'zh-CN' ? zhCN : enUS }),
    [locale, setLocale, t]
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
};

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
