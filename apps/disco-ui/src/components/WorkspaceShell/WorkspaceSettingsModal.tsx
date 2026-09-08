import {
  ApiOutlined,
  AppstoreOutlined,
  BgColorsOutlined,
  CalendarOutlined,
  DeleteOutlined,
  DollarOutlined,
  EditOutlined,
  InboxOutlined,
  LinkOutlined,
  LockOutlined,
  PlusOutlined,
  RobotOutlined,
  TeamOutlined,
  UploadOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { AGENTIC_TOOL_CAPABILITIES } from '@disco/agentic-tools';
import type { RuntimeCapabilityCatalog } from '@disco/core';
import type {
  CodexSkillCatalogEntry,
  CreateUserInput,
  DiscoClient,
  EffortLevel,
  TokenPricingRate,
  UpdateUserInput,
  User,
  UserRole,
} from '@disco-live/client';
import {
  DEFAULT_CNY_PER_USD,
  DEFAULT_CODEX_MODEL,
  OFFICIAL_TOKEN_PRICING,
  OPENAI_PRICING_SOURCE_URL,
} from '@disco-live/client';
import {
  Alert,
  theme as antdTheme,
  Button,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale } from '../../contexts/LocaleContext';
import { useOptionalTheme } from '../../contexts/ThemeContext';
import { cropAvatarImage } from '../../utils/avatarImage';
import {
  DISPLAY_SCALE_OPTIONS,
  type DisplayScale,
  getStoredDisplayScale,
  saveDisplayScale,
} from '../../utils/displayScale';
import { getDiscoPortalContainer } from '../../utils/portalContainer';
import { getPreferredReasoningEffort } from '../../utils/reasoningEffort';
import { EffortSelector } from '../EffortSelector';
import { type ModelConfig, ModelSelector } from '../ModelSelector';
import { UserIdentityAvatar } from '../UserIdentityAvatar';
import { ArchivedSessionsPanel } from './ArchivedSessionsPanel';
import { RuntimeCapabilitiesPanel } from './RuntimeCapabilitiesPanel';
import { SchedulesManagementPanel } from './SchedulesManagementPanel';
import { SharedCodexSettings } from './SharedCodexSettings';
import { SkillsManagementPanel } from './SkillsManagementPanel';

interface ProfileValues {
  name?: string;
  username: string;
  avatar_url?: string;
}

interface PasswordValues {
  password: string;
  confirmPassword: string;
}

interface ModelDefaultsValues {
  modelConfig: ModelConfig;
  effort: EffortLevel;
  serviceTier: 'default' | 'fast';
}

interface NewUserValues {
  name?: string;
  username: string;
  password: string;
  role: UserRole;
}

interface PricingRow extends TokenPricingRate {
  model: string;
}

export interface WorkspaceSettingsModalProps {
  open: boolean;
  currentUser?: User | null;
  users: User[];
  client?: DiscoClient | null;
  onClose: () => void;
  onUpdateUser?: (userId: string, updates: UpdateUserInput) => void | Promise<void>;
  onLogout?: () => void | Promise<void>;
  onCreateUser?: (data: CreateUserInput) => void | Promise<void>;
  onDeleteUser?: (userId: string) => void | Promise<void>;
  initialTab?: string | null;
  initialArchivedSessionId?: string | null;
}

const ROLE_LABELS: Record<UserRole, string> = {
  superadmin: '超级管理员',
  admin: '管理员',
  member: '成员',
  viewer: '只读成员',
};

const SETTINGS_SECTION_STYLE: React.CSSProperties = {
  width: 'min(100%, 720px)',
  height: '100%',
  margin: '0 auto',
  padding: '4px 6px 28px',
  overflowY: 'auto',
  boxSizing: 'border-box',
};
const HiddenFormValue: React.FC<{ value?: unknown; onChange?: (value: unknown) => void }> = () =>
  null;

export const WorkspaceSettingsModal: React.FC<WorkspaceSettingsModalProps> = ({
  open,
  currentUser,
  users,
  client,
  onClose,
  onUpdateUser,
  onLogout,
  onCreateUser,
  onDeleteUser,
  initialTab,
  initialArchivedSessionId,
}) => {
  const { token } = antdTheme.useToken();
  const { locale, setLocale } = useLocale();
  const themeContext = useOptionalTheme();
  const themeMode = themeContext?.themeMode ?? 'dark';
  const [profileForm] = Form.useForm<ProfileValues>();
  const [passwordForm] = Form.useForm<PasswordValues>();
  const [modelForm] = Form.useForm<ModelDefaultsValues>();
  const [newUserForm] = Form.useForm<NewUserValues>();
  const [newUserOpen, setNewUserOpen] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileUsername, setProfileUsername] = useState('');
  const [profileUsernameEdited, setProfileUsernameEdited] = useState(false);
  const [profileUsernameError, setProfileUsernameError] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordEditing, setPasswordEditing] = useState(false);
  const [savingModels, setSavingModels] = useState(false);
  const [savingPricing, setSavingPricing] = useState(false);
  const [pricingRows, setPricingRows] = useState<PricingRow[]>([]);
  const [cnyPerUsd, setCnyPerUsd] = useState(DEFAULT_CNY_PER_USD);
  const [pricingAutoUpdate, setPricingAutoUpdate] = useState(true);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState('profile');
  const [skills, setSkills] = useState<CodexSkillCatalogEntry[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [runtimeCatalog, setRuntimeCatalog] = useState<RuntimeCapabilityCatalog | null>(null);
  const [runtimeCatalogLoading, setRuntimeCatalogLoading] = useState(false);
  const [runtimeCatalogError, setRuntimeCatalogError] = useState<string | null>(null);
  const [skillSearch, setSkillSearch] = useState('');
  const [displayScale, setDisplayScale] = useState<DisplayScale>(1);
  const [skillSourceFilter, setSkillSourceFilter] = useState<'all' | 'codex-sync' | 'disco-local'>(
    'all'
  );
  const [togglingSkillId, setTogglingSkillId] = useState<string | null>(null);
  const canManageUsers = currentUser?.role === 'superadmin' || currentUser?.role === 'admin';
  const currentUserIsSuperadmin = currentUser?.role === 'superadmin';

  useEffect(() => {
    if (open && initialTab) setActiveSettingsTab(initialTab);
  }, [initialTab, open]);
  const directoryCurrentUser = useMemo(
    () => users.find((user) => user.user_id === currentUser?.user_id),
    [currentUser?.user_id, users]
  );
  const resolvedProfileUsername =
    currentUser?.username ||
    directoryCurrentUser?.username ||
    users.find(
      (user) =>
        Boolean(user.username) &&
        (user.name === currentUser?.name || (users.length === 1 && Boolean(currentUser)))
    )?.username ||
    '';
  const displayedProfileUsername = profileUsernameEdited
    ? profileUsername
    : resolvedProfileUsername || profileUsername;
  const effortLevels = AGENTIC_TOOL_CAPABILITIES.codex.reasoningEffortLevels ?? [];
  const preferredEffort = getPreferredReasoningEffort(effortLevels) ?? 'xhigh';
  const watchedModel = Form.useWatch('modelConfig', modelForm);
  const watchedEffort = Form.useWatch('effort', modelForm);
  const watchedAvatarUrl = Form.useWatch('avatar_url', profileForm);

  useEffect(() => {
    if (!open || !currentUser) return;
    const savedModel = currentUser.default_agentic_config?.codex?.modelConfig;
    profileForm.setFieldsValue({
      name: currentUser.name,
      avatar_url: currentUser.avatar_url || directoryCurrentUser?.avatar_url,
    });
    setProfileUsername(resolvedProfileUsername);
    setProfileUsernameEdited(false);
    setProfileUsernameError(null);
    modelForm.setFieldsValue({
      modelConfig: {
        mode: savedModel?.mode ?? 'alias',
        model: savedModel?.model ?? DEFAULT_CODEX_MODEL,
        provider: savedModel?.provider,
      },
      effort: savedModel?.effort ?? preferredEffort,
      serviceTier: savedModel?.serviceTier ?? 'default',
    });
    passwordForm.resetFields();
    setProfileEditing(false);
    setPasswordEditing(false);
    setPasswordChanged(false);
    setAvatarError(null);
    const pricingPreferences = currentUser.preferences?.tokenPricing;
    setCnyPerUsd(pricingPreferences?.cnyPerUsd ?? DEFAULT_CNY_PER_USD);
    setPricingAutoUpdate(pricingPreferences?.autoUpdate !== false);
    setPricingRows(
      Object.entries({ ...OFFICIAL_TOKEN_PRICING, ...(pricingPreferences?.models ?? {}) })
        .map(([model, rate]) => ({ model, ...rate }))
        .sort((left, right) => left.model.localeCompare(right.model))
    );
    setDisplayScale(getStoredDisplayScale(currentUser.user_id));
  }, [
    currentUser,
    directoryCurrentUser,
    modelForm,
    open,
    passwordForm,
    preferredEffort,
    profileForm,
    resolvedProfileUsername,
  ]);

  useEffect(() => {
    if (!open || !currentUser || !client) return;
    let cancelled = false;
    void client
      .service('users')
      .get(currentUser.user_id)
      .then((freshUser) => {
        if (cancelled) return;
        profileForm.setFieldsValue({
          name: freshUser.name,
          avatar_url: freshUser.avatar_url,
        });
        if (freshUser.username) setProfileUsername(freshUser.username);
      })
      .catch(() => {
        // The already loaded directory/user data remains a safe fallback if
        // refreshing the profile is temporarily unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [client, currentUser, open, profileForm]);

  const loadSkills = useCallback(async () => {
    if (!client) return;
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const result = await client.service('codex-skills').find();
      setSkills(Array.isArray(result) ? result : result.data);
    } catch (error) {
      setSkillsError(error instanceof Error ? error.message : '技能列表加载失败');
    } finally {
      setSkillsLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (!open || activeSettingsTab !== 'skills' || !client) return;
    void loadSkills();
  }, [activeSettingsTab, client, loadSkills, open]);

  const loadRuntimeCatalog = useCallback(async () => {
    if (!client) return;
    setRuntimeCatalogLoading(true);
    setRuntimeCatalogError(null);
    try {
      setRuntimeCatalog(await client.service('runtime-capabilities').find());
    } catch (error) {
      setRuntimeCatalogError(error instanceof Error ? error.message : '能力目录加载失败');
    } finally {
      setRuntimeCatalogLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (!open || activeSettingsTab !== 'capabilities' || !client) return;
    void loadRuntimeCatalog();
  }, [activeSettingsTab, client, loadRuntimeCatalog, open]);

  const sortedUsers = useMemo(
    () => [...users].sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username)),
    [users]
  );

  const resetProfileDraft = () => {
    profileForm.setFieldsValue({
      name: currentUser?.name || directoryCurrentUser?.name,
      avatar_url: currentUser?.avatar_url || directoryCurrentUser?.avatar_url,
    });
    setProfileUsername(resolvedProfileUsername);
    setProfileUsernameEdited(false);
    setProfileUsernameError(null);
    setAvatarError(null);
  };

  const saveProfile = async () => {
    if (!currentUser || !onUpdateUser) return;
    const values = await profileForm.validateFields();
    const normalizedUsername = displayedProfileUsername.trim().toLowerCase();
    if (!normalizedUsername) {
      setProfileUsernameError('请输入登录账号');
      return;
    }
    if (!/^\S{2,64}$/u.test(normalizedUsername)) {
      setProfileUsernameError('用户名需为 2–64 个字符，且不能包含空格');
      return;
    }
    setProfileUsernameError(null);
    setSavingProfile(true);
    try {
      await Promise.resolve(
        onUpdateUser(currentUser.user_id, {
          name: values.name?.trim() || undefined,
          username: normalizedUsername,
          avatar_url: values.avatar_url?.trim() || null,
        })
      );
      setProfileEditing(false);
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async () => {
    if (!currentUser || !onUpdateUser) return;
    const values = await passwordForm.validateFields();
    setSavingPassword(true);
    try {
      await Promise.resolve(onUpdateUser(currentUser.user_id, { password: values.password }));
      passwordForm.resetFields();
      if (onLogout) {
        onClose();
        await Promise.resolve(onLogout());
      } else {
        setPasswordChanged(true);
        setPasswordEditing(false);
      }
    } finally {
      setSavingPassword(false);
    }
  };

  const saveModelDefaults = async () => {
    if (!currentUser || !onUpdateUser) return;
    const values = await modelForm.validateFields();
    const currentDefaults = currentUser.default_agentic_config ?? {};
    const currentCodex = currentDefaults.codex ?? {};
    setSavingModels(true);
    try {
      await Promise.resolve(
        onUpdateUser(currentUser.user_id, {
          default_agentic_config: {
            ...currentDefaults,
            codex: {
              ...currentCodex,
              modelConfig: {
                ...currentCodex.modelConfig,
                ...values.modelConfig,
                effort: values.effort,
                serviceTier: values.serviceTier,
              },
            },
          },
        })
      );
    } finally {
      setSavingModels(false);
    }
  };

  const createUser = async () => {
    if (!onCreateUser) return;
    const values = await newUserForm.validateFields();
    await Promise.resolve(
      onCreateUser({
        name: values.name?.trim() || undefined,
        username: values.username.trim().toLowerCase(),
        password: values.password,
        role: values.role,
      })
    );
    setNewUserOpen(false);
    newUserForm.resetFields();
  };

  const updatePricingRow = (
    model: string,
    field: 'inputUsdPerMillion' | 'cachedInputUsdPerMillion' | 'outputUsdPerMillion',
    value: number | null
  ) => {
    setPricingRows((rows) =>
      rows.map((row) =>
        row.model === model
          ? {
              ...row,
              [field]: Math.max(0, value ?? 0),
              source: 'manual',
              updatedAt: new Date().toISOString(),
            }
          : row
      )
    );
  };

  const savePricing = async () => {
    if (!currentUser || !onUpdateUser) return;
    const overrides = Object.fromEntries(
      pricingRows
        .filter((row) => row.source !== 'official' || !(row.model in OFFICIAL_TOKEN_PRICING))
        .map(({ model, ...rate }) => [model, rate])
    );
    setSavingPricing(true);
    try {
      await Promise.resolve(
        onUpdateUser(currentUser.user_id, {
          preferences: {
            ...(currentUser.preferences ?? {}),
            tokenPricing: {
              cnyPerUsd: Math.max(0, cnyPerUsd),
              autoUpdate: pricingAutoUpdate,
              models: overrides,
            },
          },
        })
      );
    } finally {
      setSavingPricing(false);
    }
  };

  const toggleSkill = async (skill: CodexSkillCatalogEntry, enabled: boolean) => {
    if (!client || !canManageSkill(skill) || !skill.available) return;
    setTogglingSkillId(skill.id);
    setSkillsError(null);
    try {
      const updated = await client.service('codex-skills').patch(skill.id, { enabled });
      setSkills((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (error) {
      setSkillsError(error instanceof Error ? error.message : '技能状态更新失败');
    } finally {
      setTogglingSkillId(null);
    }
  };

  const canManageSkill = (skill: CodexSkillCatalogEntry) =>
    canManageUsers || skill.lifecycle?.owner_user_id === currentUser?.user_id;

  const uninstallSkill = async (skill: CodexSkillCatalogEntry): Promise<boolean> => {
    if (!client || !skill.lifecycle || !canManageSkill(skill)) return false;
    setTogglingSkillId(skill.id);
    setSkillsError(null);
    try {
      await client.service('codex-skills').patch(skill.id, {
        action: 'uninstall',
        confirmation: skill.name,
      });
      setSkills((current) => current.filter((entry) => entry.id !== skill.id));
      return true;
    } catch (error) {
      setSkillsError(error instanceof Error ? error.message : '技能卸载失败');
      return false;
    } finally {
      setTogglingSkillId(null);
    }
  };

  const profilePanel = (
    <div style={SETTINGS_SECTION_STYLE}>
      <div className="disco-settings-panel-heading">
        <Typography.Title level={4} style={{ margin: 0 }}>
          个人资料
        </Typography.Title>
        <Button
          type="text"
          icon={<EditOutlined />}
          aria-label="编辑个人资料"
          aria-hidden={profileEditing}
          tabIndex={profileEditing ? -1 : 0}
          className={profileEditing ? 'disco-edit-trigger is-placeholder' : 'disco-edit-trigger'}
          onClick={() => setProfileEditing(true)}
        >
          编辑
        </Button>
      </div>
      <Form<ProfileValues> form={profileForm} layout="vertical" requiredMark={false}>
        <Form.Item name="avatar_url" hidden>
          <HiddenFormValue />
        </Form.Item>
        <div className="disco-settings-avatar-editor">
          <UserIdentityAvatar
            user={
              currentUser
                ? {
                    ...(directoryCurrentUser ?? currentUser),
                    ...currentUser,
                    avatar_url: watchedAvatarUrl || undefined,
                  }
                : null
            }
            size={76}
          />
          <div className="disco-settings-avatar-actions">
            <Space wrap>
              <Upload
                accept="image/*"
                disabled={!profileEditing}
                showUploadList={false}
                beforeUpload={(file) => {
                  setUploadingAvatar(true);
                  setAvatarError(null);
                  void cropAvatarImage(file)
                    .then((avatarUrl) => profileForm.setFieldValue('avatar_url', avatarUrl))
                    .catch((error) =>
                      setAvatarError(error instanceof Error ? error.message : '头像处理失败')
                    )
                    .finally(() => setUploadingAvatar(false));
                  return Upload.LIST_IGNORE;
                }}
              >
                <Button
                  icon={<UploadOutlined />}
                  loading={uploadingAvatar}
                  disabled={!profileEditing}
                >
                  上传图片
                </Button>
              </Upload>
              {watchedAvatarUrl && (
                <Button
                  type="text"
                  disabled={!profileEditing}
                  onClick={() => profileForm.setFieldValue('avatar_url', '')}
                >
                  移除头像
                </Button>
              )}
            </Space>
            <Typography.Text type={avatarError ? 'danger' : 'secondary'}>
              {avatarError || '支持常见图片格式，最大 5 MB'}
            </Typography.Text>
          </div>
        </div>
        <Form.Item name="name" label="昵称">
          <Input disabled={!profileEditing} placeholder="你的昵称" autoComplete="name" />
        </Form.Item>
        <Form.Item
          label="登录账号"
          required
          validateStatus={profileUsernameError ? 'error' : undefined}
          help={profileUsernameError}
        >
          <Input
            aria-label="登录账号"
            autoComplete="username"
            disabled={!profileEditing}
            maxLength={64}
            value={displayedProfileUsername}
            onChange={(event) => {
              setProfileUsernameEdited(true);
              setProfileUsername(event.target.value);
              if (profileUsernameError) setProfileUsernameError(null);
            }}
          />
        </Form.Item>
        <div
          className={`disco-settings-edit-actions${profileEditing ? ' is-editing' : ''}`}
          aria-hidden={!profileEditing}
        >
          {profileEditing && (
            <Space>
              <Button
                aria-label="取消编辑个人资料"
                disabled={savingProfile}
                onClick={() => {
                  resetProfileDraft();
                  setProfileEditing(false);
                }}
              >
                取消
              </Button>
              <Popconfirm
                title="确认保存个人资料？"
                description="昵称、登录账号和头像将立即更新。"
                okText="确认保存"
                cancelText="继续编辑"
                onConfirm={() => void saveProfile()}
              >
                <Button
                  type="primary"
                  className="disco-settings-save-button"
                  loading={savingProfile}
                >
                  保存资料
                </Button>
              </Popconfirm>
            </Space>
          )}
        </div>
      </Form>
    </div>
  );

  const modelPanel = (
    <div style={SETTINGS_SECTION_STYLE}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        模型与思考
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        这些默认值用于新对话；桌面端可在会话输入框旁单独调整。
      </Typography.Paragraph>
      <Form<ModelDefaultsValues> form={modelForm} layout="vertical" requiredMark={false}>
        <Form.Item name="modelConfig" hidden>
          <HiddenFormValue />
        </Form.Item>
        <Form.Item label="默认模型">
          <div style={{ width: 'min(100%, 360px)' }}>
            <ModelSelector
              value={watchedModel}
              onChange={(modelConfig) => modelForm.setFieldValue('modelConfig', modelConfig)}
              agentic_tool="codex"
              client={client}
              catalogEnabled={false}
              compact
              showAdvisor={false}
            />
          </div>
        </Form.Item>
        <Form.Item label="默认思考深度" required>
          <div style={{ width: 'min(100%, 240px)' }}>
            <EffortSelector
              value={watchedEffort ?? preferredEffort}
              onChange={(effort) => effort && modelForm.setFieldValue('effort', effort)}
              levels={effortLevels}
              fallbackValue={preferredEffort}
              allowInherited={false}
              fullWidth
              plain
            />
          </div>
        </Form.Item>
        <Form.Item name="effort" hidden>
          <HiddenFormValue />
        </Form.Item>
        <Form.Item name="serviceTier" label="默认响应模式">
          <Segmented
            options={[
              { label: '普通', value: 'default' },
              { label: '快速', value: 'fast' },
            ]}
          />
        </Form.Item>
        <Button
          type="primary"
          className="disco-settings-save-button"
          loading={savingModels}
          onClick={() => void saveModelDefaults()}
        >
          保存默认值
        </Button>
      </Form>
    </div>
  );

  const appearancePanel = (
    <div style={SETTINGS_SECTION_STYLE}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        界面
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        调整语言和外观。控件字号、间距与颜色会在整个工作区保持一致。
      </Typography.Paragraph>
      <div className="disco-settings-field-row">
        <div>
          <Typography.Text strong>界面语言</Typography.Text>
          <Typography.Text type="secondary">菜单、按钮和状态文字</Typography.Text>
        </div>
        <Select
          value={locale}
          style={{ width: 170 }}
          options={[
            { value: 'zh-CN', label: '简体中文' },
            { value: 'en-US', label: 'English' },
          ]}
          onChange={setLocale}
        />
      </div>
      <div className="disco-settings-field-row">
        <div>
          <Typography.Text strong>主题</Typography.Text>
          <Typography.Text type="secondary">选择浅色或深色界面</Typography.Text>
        </div>
        <Segmented
          value={themeMode === 'light' ? 'light' : 'dark'}
          options={[
            { label: '浅色', value: 'light' },
            { label: '深色', value: 'dark' },
          ]}
          onChange={(value) => themeContext?.setThemeMode(value as 'light' | 'dark')}
        />
      </div>
      <div className="disco-settings-field-row">
        <div>
          <Typography.Text strong>本机显示比例</Typography.Text>
          <Typography.Text type="secondary">
            同时放大字号、控件和间距；仅保存在当前账号与这台浏览器中
          </Typography.Text>
        </div>
        <Select
          aria-label="本机显示比例"
          value={displayScale}
          style={{ width: 170 }}
          options={DISPLAY_SCALE_OPTIONS.map((scale) => ({
            value: scale,
            label: `${Math.round(scale * 100)}%`,
          }))}
          onChange={(value) => {
            if (!currentUser) return;
            setDisplayScale(saveDisplayScale(currentUser.user_id, value));
          }}
        />
      </div>
    </div>
  );

  const securityPanel = (
    <div style={SETTINGS_SECTION_STYLE}>
      <div className="disco-settings-panel-heading">
        <Typography.Title level={4} style={{ margin: 0 }}>
          账号与安全
        </Typography.Title>
        <Button
          type="text"
          icon={<EditOutlined />}
          aria-label="编辑登录密码"
          aria-hidden={passwordEditing}
          tabIndex={passwordEditing ? -1 : 0}
          className={passwordEditing ? 'disco-edit-trigger is-placeholder' : 'disco-edit-trigger'}
          onClick={() => {
            setPasswordEditing(true);
            setPasswordChanged(false);
          }}
        >
          编辑
        </Button>
      </div>
      {passwordChanged && (
        <Alert
          type="success"
          showIcon
          title="密码已更新；如果当前登录失效，请使用新密码重新登录。"
          style={{ marginBottom: 16 }}
        />
      )}
      <Form<PasswordValues> form={passwordForm} layout="vertical" requiredMark={false}>
        <Form.Item
          name="password"
          label="新密码"
          rules={[{ required: true, min: 8, message: '密码至少需要 8 个字符' }]}
        >
          <Input.Password disabled={!passwordEditing} autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label="确认新密码"
          dependencies={['password']}
          rules={[
            { required: true, message: '请再次输入新密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                return !value || getFieldValue('password') === value
                  ? Promise.resolve()
                  : Promise.reject(new Error('两次输入的密码不一致'));
              },
            }),
          ]}
        >
          <Input.Password disabled={!passwordEditing} autoComplete="new-password" />
        </Form.Item>
        <div
          className={`disco-settings-edit-actions${passwordEditing ? ' is-editing' : ''}`}
          aria-hidden={!passwordEditing}
        >
          {passwordEditing && (
            <Space>
              <Button
                aria-label="取消编辑登录密码"
                disabled={savingPassword}
                onClick={() => {
                  passwordForm.resetFields();
                  setPasswordEditing(false);
                }}
              >
                取消
              </Button>
              <Popconfirm
                title="确认更新登录密码？"
                description="保存后，其他已登录页面可能需要使用新密码重新登录。"
                okText="确认更新"
                cancelText="继续编辑"
                onConfirm={() => void savePassword()}
              >
                <Button
                  type="primary"
                  className="disco-settings-save-button"
                  loading={savingPassword}
                >
                  更新密码
                </Button>
              </Popconfirm>
            </Space>
          )}
        </div>
      </Form>
    </div>
  );

  const codexPanel = (
    <div style={SETTINGS_SECTION_STYLE}>
      <SharedCodexSettings client={client} canManage={canManageUsers} />
    </div>
  );

  const skillsPanel = (
    <SkillsManagementPanel
      skills={skills}
      skillsLoading={skillsLoading}
      skillsError={skillsError}
      onDismissError={() => setSkillsError(null)}
      canManageSkill={canManageSkill}
      skillSourceFilter={skillSourceFilter}
      onSkillSourceFilterChange={setSkillSourceFilter}
      search={skillSearch}
      onSearchChange={setSkillSearch}
      togglingId={togglingSkillId}
      onToggleSkill={(skill, enabled) => void toggleSkill(skill, enabled)}
      onUninstallSkill={uninstallSkill}
      onRefreshShared={() => void loadSkills()}
    />
  );

  const schedulesPanel = <SchedulesManagementPanel client={client} currentUser={currentUser} />;

  const runtimeCapabilitiesPanel = (
    <RuntimeCapabilitiesPanel
      catalog={runtimeCatalog}
      loading={runtimeCatalogLoading}
      error={runtimeCatalogError}
      onRefresh={() => void loadRuntimeCatalog()}
      onDismissError={() => setRuntimeCatalogError(null)}
    />
  );

  const pricingPanel = (
    <div className="disco-settings-scroll-pane" style={{ padding: '4px 6px 28px' }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        Token 报价
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ maxWidth: 680 }}>
        用于首页人民币费用估算。默认采用 OpenAI 官方 API 标价；Cache 输入与普通输入分别计价。
        未识别的新模型可由轻量模型异步补全，也可以直接修改表格。
      </Typography.Paragraph>
      <div
        className="disco-token-pricing-toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 14,
          marginBottom: 16,
          padding: '12px 14px',
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          background: token.colorFillQuaternary,
        }}
      >
        <Space size={18} wrap>
          <Space size={8}>
            <Typography.Text>美元兑人民币</Typography.Text>
            <InputNumber
              min={0}
              step={0.01}
              precision={4}
              value={cnyPerUsd}
              onChange={(value) => setCnyPerUsd(value ?? DEFAULT_CNY_PER_USD)}
              style={{ width: 112 }}
            />
          </Space>
          <Space size={8}>
            <Switch checked={pricingAutoUpdate} onChange={setPricingAutoUpdate} />
            <Typography.Text>自动补全未知模型</Typography.Text>
          </Space>
        </Space>
        <Typography.Link href={OPENAI_PRICING_SOURCE_URL} target="_blank" rel="noreferrer">
          查看官方报价
        </Typography.Link>
      </div>
      <Table<PricingRow>
        className="disco-token-pricing-table"
        rowKey="model"
        size="small"
        pagination={false}
        tableLayout="fixed"
        dataSource={pricingRows}
        columns={[
          {
            title: '模型',
            dataIndex: 'model',
            width: '26%',
            ellipsis: true,
            render: (value: string) => (
              <Typography.Text code ellipsis={{ tooltip: value }}>
                {value}
              </Typography.Text>
            ),
          },
          ...(
            [
              ['inputUsdPerMillion', '输入'],
              ['cachedInputUsdPerMillion', 'Cache'],
              ['outputUsdPerMillion', '输出'],
            ] as const
          ).map(([field, title]) => ({
            title: `${title} USD/1M`,
            dataIndex: field,
            width: '19%',
            render: (value: number, row: PricingRow) => (
              <InputNumber
                min={0}
                step={0.01}
                precision={4}
                value={value}
                onChange={(next) => updatePricingRow(row.model, field, next)}
                style={{ width: '100%' }}
              />
            ),
          })),
          {
            title: '来源',
            dataIndex: 'source',
            width: '17%',
            render: (source: PricingRow['source']) => (
              <Tag color={source === 'manual' ? 'blue' : source === 'automatic' ? 'cyan' : 'green'}>
                {source === 'manual' ? '手动' : source === 'automatic' ? '自动' : '官方'}
              </Tag>
            ),
          },
        ]}
      />
      <Space className="disco-token-pricing-footer" style={{ marginTop: 16 }}>
        <Button
          type="primary"
          className="disco-settings-save-button"
          loading={savingPricing}
          onClick={() => void savePricing()}
        >
          保存报价
        </Button>
        <Typography.Text type="secondary">
          费用仅作 API 等价估算，不代表订阅额度扣费。
        </Typography.Text>
      </Space>
    </div>
  );

  const usersPanel = (
    <div className="disco-settings-scroll-pane" style={{ padding: '4px 6px 28px' }}>
      <div className="disco-settings-panel-heading">
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            家庭账号
          </Typography.Title>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setNewUserOpen(true)}>
          添加账号
        </Button>
      </div>
      <List
        className="disco-family-account-list"
        dataSource={sortedUsers}
        style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }}
        renderItem={(member) => {
          const protectsSuperadminFromAdmin =
            member.role === 'superadmin' && !currentUserIsSuperadmin;
          const memberMutationDisabled =
            member.user_id === currentUser?.user_id || protectsSuperadminFromAdmin;
          const assignableRoles = (Object.keys(ROLE_LABELS) as UserRole[]).filter(
            (role) => currentUserIsSuperadmin || role !== 'superadmin'
          );

          return (
            <List.Item
              actions={[
                <Select<UserRole>
                  key="role"
                  value={member.role}
                  disabled={memberMutationDisabled || !onUpdateUser}
                  style={{ width: 126 }}
                  options={assignableRoles.map((role) => ({
                    value: role,
                    label: ROLE_LABELS[role],
                  }))}
                  onChange={(role) => void onUpdateUser?.(member.user_id, { role })}
                />,
                <Popconfirm
                  key="delete"
                  title="删除这个账号？"
                  description="该账号将无法继续登录。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  disabled={memberMutationDisabled || !onDeleteUser}
                  onConfirm={() => onDeleteUser?.(member.user_id)}
                >
                  <Button
                    type="text"
                    danger
                    aria-label={`删除 ${member.name || member.username}`}
                    icon={<DeleteOutlined />}
                    disabled={memberMutationDisabled || !onDeleteUser}
                  />
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                avatar={<UserIdentityAvatar user={member} size={36} />}
                title={
                  <Space size={8}>
                    <span>{member.name || member.username}</span>
                    {member.user_id === currentUser?.user_id && <Tag color="green">当前账号</Tag>}
                  </Space>
                }
                description={member.username}
              />
            </List.Item>
          );
        }}
      />
    </div>
  );

  const mobileSettingsOptions = [
    { value: 'profile', label: '个人资料' },
    { value: 'models', label: '模型与思考' },
    { value: 'appearance', label: '界面' },
    { value: 'security', label: '账号与安全' },
    { value: 'skills', label: '技能管理' },
    { value: 'archives', label: '已归档会话' },
    ...(canManageUsers ? [{ value: 'capabilities', label: '能力目录' }] : []),
    { value: 'schedules', label: '计划任务' },
    { value: 'codex', label: 'Codex 连接' },
    { value: 'pricing', label: 'Token 报价' },
    ...(canManageUsers ? [{ value: 'users', label: '家庭账号' }] : []),
  ];

  return (
    <>
      <Modal
        getContainer={getDiscoPortalContainer}
        title="设置"
        open={open}
        centered
        width="min(1020px, calc(var(--disco-effective-vw, 100vw) - 32px))"
        footer={null}
        onCancel={onClose}
        afterOpenChange={(visible) => {
          if (!visible || !currentUser) return;
          const listedUser = users.find((user) => user.user_id === currentUser.user_id);
          profileForm.setFieldsValue({
            name: currentUser.name || listedUser?.name,
            avatar_url: currentUser.avatar_url || listedUser?.avatar_url,
          });
          setProfileUsername(
            currentUser.username || listedUser?.username || resolvedProfileUsername
          );
          setProfileUsernameEdited(false);
          setProfileUsernameError(null);
          setProfileEditing(false);
          setPasswordEditing(false);
        }}
        destroyOnHidden
        className="disco-workspace-settings-modal"
        wrapClassName="disco-workspace-settings-wrap"
        styles={{
          body: {
            height: 'min(560px, calc(var(--disco-effective-vh, 100vh) - 96px))',
            minHeight: 0,
            paddingTop: 8,
            overflow: 'hidden',
          },
        }}
      >
        <div className="disco-settings-mobile-nav">
          <Typography.Text type="secondary">设置页面</Typography.Text>
          <Select
            aria-label="设置页面"
            value={activeSettingsTab}
            options={mobileSettingsOptions}
            onChange={setActiveSettingsTab}
          />
        </div>
        <Tabs
          tabPlacement="start"
          activeKey={activeSettingsTab}
          onChange={setActiveSettingsTab}
          items={[
            {
              key: 'profile',
              label: (
                <span>
                  <UserOutlined /> 个人资料
                </span>
              ),
              children: profilePanel,
            },
            {
              key: 'models',
              label: (
                <span>
                  <RobotOutlined /> 模型与思考
                </span>
              ),
              children: modelPanel,
            },
            {
              key: 'appearance',
              label: (
                <span>
                  <BgColorsOutlined /> 界面
                </span>
              ),
              children: appearancePanel,
            },
            {
              key: 'security',
              label: (
                <span>
                  <LockOutlined /> 账号与安全
                </span>
              ),
              children: securityPanel,
            },
            {
              key: 'skills',
              label: (
                <span>
                  <AppstoreOutlined /> 技能管理
                </span>
              ),
              children: skillsPanel,
            },
            {
              key: 'archives',
              label: (
                <span>
                  <InboxOutlined /> 已归档会话
                </span>
              ),
              children: (
                <ArchivedSessionsPanel
                  client={client}
                  active={open && activeSettingsTab === 'archives'}
                  initialSessionId={initialArchivedSessionId}
                />
              ),
            },
            ...(canManageUsers
              ? [
                  {
                    key: 'capabilities',
                    label: (
                      <span>
                        <ApiOutlined /> 能力目录
                      </span>
                    ),
                    children: runtimeCapabilitiesPanel,
                  },
                ]
              : []),
            {
              key: 'schedules',
              label: (
                <span>
                  <CalendarOutlined /> 计划任务
                </span>
              ),
              children: schedulesPanel,
            },
            {
              key: 'codex',
              label: (
                <span>
                  <LinkOutlined /> Codex 连接
                </span>
              ),
              children: codexPanel,
            },
            {
              key: 'pricing',
              label: (
                <span>
                  <DollarOutlined /> Token 报价
                </span>
              ),
              children: pricingPanel,
            },
            ...(canManageUsers
              ? [
                  {
                    key: 'users',
                    label: (
                      <span>
                        <TeamOutlined /> 家庭账号
                      </span>
                    ),
                    children: usersPanel,
                  },
                ]
              : []),
          ]}
        />
      </Modal>
      <Modal
        getContainer={getDiscoPortalContainer}
        title="添加家庭账号"
        open={newUserOpen}
        okText="创建账号"
        cancelText="取消"
        onCancel={() => setNewUserOpen(false)}
        onOk={() => void createUser()}
        destroyOnHidden
      >
        <Form<NewUserValues>
          form={newUserForm}
          layout="vertical"
          requiredMark={false}
          initialValues={{ role: 'member' }}
        >
          <Form.Item name="name" label="昵称">
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="username"
            label="用户名"
            rules={[
              { required: true, message: '请输入用户名' },
              {
                transform: (value: unknown) => (typeof value === 'string' ? value.trim() : value),
                pattern: /^\S{2,64}$/u,
                message: '用户名需为 2–64 个字符，且不能包含空格',
              },
            ]}
          >
            <Input autoComplete="username" maxLength={64} />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始密码"
            rules={[{ required: true, min: 8, message: '密码至少需要 8 个字符' }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label="权限">
            <Segmented
              block
              options={[
                { label: '成员', value: 'member' },
                { label: '只读', value: 'viewer' },
                { label: '管理员', value: 'admin' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};
