import {
  Pulse as Activity,
  CheckCircle as CheckCircle2,
  Key as KeyRound,
  Link as Link2,
  LockKey as LockKeyhole,
  Plus,
  ArrowClockwise as RefreshCcw,
  FloppyDisk as Save,
  MagnifyingGlass as Search,
  ShieldCheck,
  Trash as Trash2,
} from "@phosphor-icons/react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type {
  AccountConfig,
  AccountProviderCapabilities,
  MetaAccessProfile,
  MetaAccessProfileInput,
  MetaMarketingApiLiveMode,
  MetaCreationMode,
  MetaStatusEntityType,
  ProviderConnection,
} from "@tk-auto/core";
import { api, ApiRequestError, type MetaDiscoveredAdAccount } from "./api";
import { useAuth } from "./AuthGate";
import { hasProviderCapability } from "./provider-capability-view";
import { useOverlays } from "./ui/overlays";
import "./ui/pages/meta-connection.css";

export interface AccountBindingDraft {
  profileId: string;
  adAccountId: string;
  pageId: string;
  liveMode: MetaMarketingApiLiveMode;
  allowedStatusEntityTypes: MetaStatusEntityType[];
  creationMode: MetaCreationMode;
}

type ProfileField = "name" | "appId" | "businessId" | "graphApiVersion";
type SecretField = "appSecret" | "accessToken";
type BindingField = "profileId" | "adAccountId" | "pageId";
type FieldErrors<Field extends string> = Partial<Record<Field, string>>;

export function validateMetaProfileDraft(
  input: MetaAccessProfileInput,
): FieldErrors<ProfileField> {
  const errors: FieldErrors<ProfileField> = {};
  const name = input.name.trim();
  const appId = input.appId.trim();
  const businessId = input.businessId?.trim() ?? "";
  const graphApiVersion = input.graphApiVersion.trim();

  if (!name) errors.name = "请输入档案名称。";
  else if (name.length > 80) errors.name = "档案名称最多 80 个字符。";
  if (!appId) errors.appId = "请输入 Meta App ID（仅数字）。";
  else if (!/^\d+$/.test(appId)) errors.appId = "App ID 只能包含数字，不要填写名称或网址。";
  if (businessId && !/^\d+$/.test(businessId)) {
    errors.businessId = "Business Portfolio ID 只能包含数字；没有 BM 时请留空。";
  }
  if (!graphApiVersion) errors.graphApiVersion = "请输入 Graph API 版本，例如 v25.0。";
  else if (!/^v\d+\.\d+$/.test(graphApiVersion)) {
    errors.graphApiVersion = "Graph API 版本格式应为 v数字.数字，例如 v25.0。";
  }
  return errors;
}

export function validateMetaSecretDraft(input: {
  appSecret: string;
  accessToken: string;
}): FieldErrors<SecretField> {
  const errors: FieldErrors<SecretField> = {};
  const appSecret = input.appSecret.trim();
  const accessToken = input.accessToken.trim();
  if (!appSecret) errors.appSecret = "请输入 App Secret。";
  else if (appSecret.length < 8) errors.appSecret = "App Secret 至少需要 8 个字符。";
  else if (appSecret.length > 512) errors.appSecret = "App Secret 最多允许 512 个字符。";
  if (!accessToken) errors.accessToken = "请输入 Access Token。";
  else if (accessToken.length < 20) errors.accessToken = "Access Token 至少需要 20 个字符。";
  else if (accessToken.length > 8192) errors.accessToken = "Access Token 最多允许 8192 个字符。";
  return errors;
}

export function validateMetaBindingDraft(
  input: AccountBindingDraft,
): FieldErrors<BindingField> {
  const errors: FieldErrors<BindingField> = {};
  const adAccountId = input.adAccountId.trim();
  const pageId = input.pageId.trim();
  if (!input.profileId) errors.profileId = "请选择已保存的共享 App 档案。";
  if (!adAccountId) errors.adAccountId = "请输入广告账户 ID，例如 act_1705718683974303。";
  else if (!/^(?:act_)?\d+$/.test(adAccountId)) {
    errors.adAccountId = "广告账户 ID 应为 act_数字；只填数字也会自动补全 act_。";
  } else if ((adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`).length > 68) {
    errors.adAccountId = "广告账户 ID 长度超过 68 个字符。";
  }
  if (pageId && !/^\d+$/.test(pageId)) {
    errors.pageId = "Facebook Page ID 只能包含数字；不需要 Page 时请留空。";
  }
  return errors;
}

function firstFieldError<Field extends string>(errors: FieldErrors<Field>): string | null {
  return Object.values(errors).find((message): message is string => typeof message === "string") ?? null;
}

function apiFieldErrors<Field extends string>(
  cause: unknown,
  fields: readonly Field[],
): FieldErrors<Field> {
  if (!(cause instanceof ApiRequestError)) return {};
  const errors: FieldErrors<Field> = {};
  for (const field of fields) {
    const message = cause.getFieldMessage(field);
    if (message) errors[field] = message;
  }
  return errors;
}

const emptyProfileDraft: MetaAccessProfileInput = {
  name: "",
  appId: "",
  businessId: null,
  graphApiVersion: "v25.0",
};

const emptyBinding: AccountBindingDraft = {
  profileId: "",
  adAccountId: "",
  pageId: "",
  liveMode: "disabled",
  allowedStatusEntityTypes: ["campaign", "ad-group", "ad"],
  creationMode: "disabled",
};

export function MetaConnectionPage({
  account,
  onConnectionReady,
  onError,
}: {
  account: AccountConfig;
  onConnectionReady?: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const auth = useAuth();
  const { confirm, toast } = useOverlays();
  const canManageAccounts = auth.status.permissions.includes("accounts:manage");
  const [profiles, setProfiles] = useState<MetaAccessProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileDraft, setProfileDraft] = useState<MetaAccessProfileInput>(emptyProfileDraft);
  const [appSecret, setAppSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [profileErrors, setProfileErrors] = useState<FieldErrors<ProfileField>>({});
  const [secretErrors, setSecretErrors] = useState<FieldErrors<SecretField>>({});
  const [bindingErrors, setBindingErrors] = useState<FieldErrors<BindingField>>({});
  const [binding, setBinding] = useState<AccountBindingDraft>(emptyBinding);
  const [connection, setConnection] = useState<ProviderConnection | null>(null);
  const [profile, setProfile] = useState<AccountProviderCapabilities | null>(null);
  const [discoveredAccounts, setDiscoveredAccounts] = useState<MetaDiscoveredAdAccount[]>([]);
  const [lastSyncMessage, setLastSyncMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextProfiles, connections, profilesByProvider] = await Promise.all([
        api.getMetaAccessProfiles(),
        api.getConnections(account.id),
        api.getConnectionCapabilities(account.id),
      ]);
      const nextConnection = connections.find((item) => item.kind === "meta-marketing-api") ?? null;
      const settings = nextConnection?.settings.kind === "meta-marketing-api"
        ? nextConnection.settings
        : null;
      const boundProfileId = settings && "profileId" in settings
        ? settings.profileId ?? ""
        : "";
      setProfiles(nextProfiles);
      setConnection(nextConnection);
      setProfile(profilesByProvider.find((item) => item.providerKind === "meta-marketing-api") ?? null);
      setBinding(settings ? {
        profileId: boundProfileId,
        adAccountId: settings.adAccountId,
        pageId: settings.pageId ?? "",
        liveMode: settings.liveMode ?? "disabled",
        allowedStatusEntityTypes: settings.allowedStatusEntityTypes ?? ["campaign", "ad-group", "ad"],
        creationMode: settings.creationMode ?? "disabled",
      } : emptyBinding);
      setBindingErrors({});
      setSelectedProfileId((current) => {
        const next = nextProfiles.some((item) => item.id === current)
          ? current
          : boundProfileId || nextProfiles[0]?.id || "";
        return next;
      });
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    }
  }, [account.id, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedProfile = profiles.find((item) => item.id === selectedProfileId) ?? null;
  useEffect(() => {
    setProfileDraft(selectedProfile ? {
      name: selectedProfile.name,
      appId: selectedProfile.appId,
      businessId: selectedProfile.businessId,
      graphApiVersion: selectedProfile.graphApiVersion,
    } : emptyProfileDraft);
    setProfileErrors({});
    setAppSecret("");
    setAccessToken("");
    setSecretErrors({});
    setDiscoveredAccounts([]);
  }, [selectedProfile]);

  const clearProfileError = (field: ProfileField) => setProfileErrors((current) => {
    if (!current[field]) return current;
    const next = { ...current };
    delete next[field];
    return next;
  });
  const clearSecretError = (field: SecretField) => setSecretErrors((current) => {
    if (!current[field]) return current;
    const next = { ...current };
    delete next[field];
    return next;
  });
  const clearBindingError = (field: BindingField) => setBindingErrors((current) => {
    if (!current[field]) return current;
    const next = { ...current };
    delete next[field];
    return next;
  });

  const selectedProfileReady = Boolean(
    selectedProfile?.hasAppSecret && selectedProfile.hasAccessToken,
  );
  const bindingProfile = profiles.find((item) => item.id === binding.profileId) ?? null;
  const bindingProfileReady = Boolean(
    bindingProfile?.hasAppSecret && bindingProfile.hasAccessToken,
  );
  const readReady = connection?.status === "ready"
    && Boolean(profile && hasProviderCapability(profile, "read-campaigns"));
  const availableCapabilities = profile?.capabilities.filter((item) => item.available) ?? [];

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedDraft: MetaAccessProfileInput = {
      name: profileDraft.name.trim(),
      appId: profileDraft.appId.trim(),
      businessId: profileDraft.businessId?.trim() || null,
      graphApiVersion: profileDraft.graphApiVersion.trim(),
    };
    const validationErrors = validateMetaProfileDraft(normalizedDraft);
    setProfileErrors(validationErrors);
    const validationMessage = firstFieldError(validationErrors);
    if (validationMessage) {
      onError(validationMessage);
      return;
    }
    const appIdChanged = Boolean(
      selectedProfile && selectedProfile.appId !== normalizedDraft.appId,
    );
    if (appIdChanged && selectedProfileReady) {
      const message = "当前 App ID 已绑定加密密钥，普通保存不会清除密钥。如需更换 App 身份，请先明确执行密钥轮换。";
      setProfileErrors((current) => ({ ...current, appId: message }));
      onError(message);
      return;
    }
    try {
      setBusy("profile");
      const saved = selectedProfile
        ? await api.updateMetaAccessProfile(selectedProfile.id, normalizedDraft)
        : await api.createMetaAccessProfile(normalizedDraft);
      setProfileErrors({});
      await load();
      setSelectedProfileId(saved.id);
      toast(appIdChanged
        ? "App ID 已更新；请保存对应的 App Secret 与 Access Token"
        : selectedProfile ? "共享 Meta App 档案已更新" : "共享 Meta App 档案已创建");
    } catch (cause) {
      setProfileErrors(apiFieldErrors(cause, ["name", "appId", "businessId", "graphApiVersion"]));
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const saveProfileSecret = async () => {
    if (!selectedProfile) return;
    const normalizedSecret = {
      appSecret: appSecret.trim(),
      accessToken: accessToken.trim(),
    };
    const validationErrors = validateMetaSecretDraft(normalizedSecret);
    setSecretErrors(validationErrors);
    const validationMessage = firstFieldError(validationErrors);
    if (validationMessage) {
      onError(validationMessage);
      return;
    }
    try {
      setBusy("profile-secret");
      await api.saveMetaAccessProfileSecret(selectedProfile.id, normalizedSecret);
      setAppSecret("");
      setAccessToken("");
      setSecretErrors({});
      await load();
      toast("App Secret 与 Access Token 已通过 DPAPI 加密保存");
    } catch (cause) {
      setSecretErrors(apiFieldErrors(cause, ["appSecret", "accessToken"]));
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const deleteProfileSecret = async () => {
    if (!selectedProfile || !await confirm({
      title: "删除共享 Meta 密钥",
      message: `确定删除“${selectedProfile.name}”的 App Secret 与 Access Token 吗？引用此档案的账户会立即失去连接能力。`,
      confirmLabel: "删除密钥",
      danger: true,
    })) return;
    try {
      setBusy("delete-secret");
      await api.deleteMetaAccessProfileSecret(selectedProfile.id);
      await load();
      toast("共享 Meta 密钥已删除");
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const deleteProfile = async () => {
    if (!selectedProfile || !await confirm({
      title: "删除共享 Meta App 档案",
      message: selectedProfile.referenceCount > 0
        ? `此档案仍被 ${selectedProfile.referenceCount} 个账户引用，后端会拒绝删除。请先解除账户绑定。`
        : `确定删除“${selectedProfile.name}”吗？此操作不会删除 Meta 远端资产。`,
      confirmLabel: "删除档案",
      danger: true,
    })) return;
    try {
      setBusy("delete-profile");
      await api.deleteMetaAccessProfile(selectedProfile.id);
      setSelectedProfileId("");
      await load();
      toast("共享 Meta App 档案已删除");
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const discoverAdAccounts = async () => {
    if (!selectedProfile) return;
    try {
      setBusy("discover");
      const accounts = await api.discoverMetaAdAccounts(selectedProfile.id);
      setDiscoveredAccounts(accounts);
      toast(`发现 ${accounts.length} 个可见广告账户`);
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const saveBinding = async (event: FormEvent) => {
    event.preventDefault();
    const validationErrors = validateMetaBindingDraft(binding);
    setBindingErrors(validationErrors);
    const validationMessage = firstFieldError(validationErrors);
    if (validationMessage) {
      onError(validationMessage);
      return;
    }
    try {
      setBusy("binding");
      const adAccountId = binding.adAccountId.trim().startsWith("act_")
        ? binding.adAccountId.trim()
        : `act_${binding.adAccountId.trim()}`;
      await api.saveConnectionSettings(account.id, "meta-marketing-api", {
        kind: "meta-marketing-api",
        profileId: binding.profileId,
        adAccountId,
        pageId: binding.pageId.trim() || null,
        liveMode: binding.liveMode,
        allowedStatusEntityTypes: binding.allowedStatusEntityTypes,
        creationMode: binding.creationMode,
      });
      setBindingErrors({});
      await load();
      toast("绑定参数已保存；请执行连接检测确认权限与账户状态");
    } catch (cause) {
      setBindingErrors(apiFieldErrors(cause, ["profileId", "adAccountId", "pageId"]));
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async () => {
    try {
      setBusy("test");
      await api.testConnection(account.id, "meta-marketing-api");
      await load();
      await onConnectionReady?.();
      toast("Meta 连接检测已完成");
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const syncReadOnly = async () => {
    try {
      setBusy("sync");
      const result = await api.syncReadOnly(account.id, "meta-marketing-api");
      setLastSyncMessage(`同步完成：广告系列 ${result.counts.campaign}、广告组 ${result.counts["ad-group"]}、广告 ${result.counts.ad}`);
      await Promise.all([load(), onConnectionReady?.()]);
      toast("Meta 广告对象已完成只读同步");
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  if (account.providerKind === "meta-offline") {
    return (
      <section className="connection-page meta-connection-page">
        <section className="connection-section"><div className="connection-subheading"><span className="connection-subheading-icon"><LockKeyhole size={18} /></span><div><h3>Meta 离线架构</h3><p>此账户固定为零网络 Provider，不能绑定共享 App 档案或开启自动化。</p></div></div></section>
      </section>
    );
  }

  return (
    <section className="connection-page meta-connection-page">
      <section className="connection-section meta-profile-section">
        <div className="connection-subheading">
          <span className="connection-subheading-icon"><KeyRound size={18} /></span>
          <div><h3>共享 Meta App 凭据档案</h3><p>App ID、App Secret 与 Access Token 全局复用；敏感值仅经 DPAPI 保存，保存后清空且永不回显。</p></div>
        </div>
        <div className="meta-profile-layout">
          <aside className="meta-profile-list">
            <button className={!selectedProfileId ? "active" : ""} onClick={() => setSelectedProfileId("")} type="button"><Plus size={15} /><span><strong>新建 App 档案</strong><small>唯一 App ID</small></span></button>
            {profiles.map((item) => <button className={selectedProfileId === item.id ? "active" : ""} key={item.id} onClick={() => setSelectedProfileId(item.id)} type="button"><ShieldCheck size={15} /><span><strong>{item.name}</strong><small>{item.appId} · 引用 {item.referenceCount}</small></span></button>)}
          </aside>
          <div className="meta-profile-editor">
            <form className="connection-form-block" noValidate onSubmit={(event) => void saveProfile(event)}>
              <div className="meta-form-heading"><div><h3>{selectedProfile ? "编辑共享档案" : "新建共享档案"}</h3><p>Business Portfolio ID 可留空，直接绑定 act_ 广告账户。</p></div>{selectedProfile && <span className="status">引用 {selectedProfile.referenceCount}</span>}</div>
              <div className="form-grid">
                <label className="field"><span>档案名称</span><input aria-describedby={profileErrors.name ? "meta-profile-name-error" : undefined} aria-invalid={Boolean(profileErrors.name)} required value={profileDraft.name} onChange={(event) => { setProfileDraft({ ...profileDraft, name: event.target.value }); clearProfileError("name"); }} />{profileErrors.name && <small className="error-text" id="meta-profile-name-error" role="alert">{profileErrors.name}</small>}</label>
                <label className="field"><span>App ID</span><input aria-describedby={profileErrors.appId ? "meta-profile-app-id-error" : undefined} aria-invalid={Boolean(profileErrors.appId)} inputMode="numeric" pattern="[0-9]+" readOnly={selectedProfileReady} required title={selectedProfileReady ? "已保存密钥后锁定，普通档案保存不会清除密钥" : undefined} value={profileDraft.appId} onChange={(event) => { setProfileDraft({ ...profileDraft, appId: event.target.value }); clearProfileError("appId"); }} />{selectedProfileReady && !profileErrors.appId && <small>已绑定密钥；普通保存不会清除或替换。</small>}{profileErrors.appId && <small className="error-text" id="meta-profile-app-id-error" role="alert">{profileErrors.appId}</small>}</label>
                <label className="field"><span>Business Portfolio ID（可选）</span><input aria-describedby={profileErrors.businessId ? "meta-profile-business-id-error" : undefined} aria-invalid={Boolean(profileErrors.businessId)} inputMode="numeric" pattern="[0-9]+" value={profileDraft.businessId ?? ""} onChange={(event) => { setProfileDraft({ ...profileDraft, businessId: event.target.value || null }); clearProfileError("businessId"); }} />{profileErrors.businessId && <small className="error-text" id="meta-profile-business-id-error" role="alert">{profileErrors.businessId}</small>}</label>
                <label className="field"><span>Graph API 版本</span><input aria-describedby={profileErrors.graphApiVersion ? "meta-profile-graph-version-error" : undefined} aria-invalid={Boolean(profileErrors.graphApiVersion)} pattern="v[0-9]+\.[0-9]+" required placeholder="例如 v25.0" value={profileDraft.graphApiVersion} onChange={(event) => { setProfileDraft({ ...profileDraft, graphApiVersion: event.target.value }); clearProfileError("graphApiVersion"); }} />{profileErrors.graphApiVersion && <small className="error-text" id="meta-profile-graph-version-error" role="alert">{profileErrors.graphApiVersion}</small>}</label>
              </div>
              <div className="connection-inline-actions"><button className="secondary-button" disabled={!canManageAccounts || busy !== null} type="submit"><Save size={16} />{busy === "profile" ? "保存中…" : "保存档案"}</button>{selectedProfile && <button className="danger-button" disabled={!canManageAccounts || busy !== null || selectedProfile.referenceCount > 0} onClick={() => void deleteProfile()} title={selectedProfile.referenceCount > 0 ? "请先解除所有广告账户绑定" : undefined} type="button"><Trash2 size={15} />删除档案</button>}</div>
            </form>

            {selectedProfile && <div className="connection-form-block meta-secret-block">
              <div className="meta-form-heading"><div><h3>App Secret + Access Token</h3><p>两项作为唯一一组整体轮换；不会显示已保存值。</p></div><div className="meta-secret-status"><span className={selectedProfile.hasAppSecret ? "status active" : "status warning"}>Secret {selectedProfile.hasAppSecret ? "已保存" : "未保存"}</span><span className={selectedProfile.hasAccessToken ? "status active" : "status warning"}>Token {selectedProfile.hasAccessToken ? "已保存" : "未保存"}</span></div></div>
              <label className="field"><span>App Secret</span><input aria-describedby={secretErrors.appSecret ? "meta-app-secret-error" : undefined} aria-invalid={Boolean(secretErrors.appSecret)} autoComplete="new-password" maxLength={512} minLength={8} type="password" value={appSecret} onChange={(event) => { setAppSecret(event.target.value); clearSecretError("appSecret"); }} placeholder="至少 8 个字符；成功保存后清空" />{secretErrors.appSecret && <small className="error-text" id="meta-app-secret-error" role="alert">{secretErrors.appSecret}</small>}</label>
              <label className="field"><span>Access Token</span><input aria-describedby={secretErrors.accessToken ? "meta-access-token-error" : undefined} aria-invalid={Boolean(secretErrors.accessToken)} autoComplete="new-password" maxLength={8192} minLength={20} spellCheck={false} type="password" value={accessToken} onChange={(event) => { setAccessToken(event.target.value); clearSecretError("accessToken"); }} placeholder="至少 20 个字符；成功保存后清空" />{secretErrors.accessToken && <small className="error-text" id="meta-access-token-error" role="alert">{secretErrors.accessToken}</small>}</label>
              <div className="connection-inline-actions"><button className="primary-button" disabled={!canManageAccounts || busy !== null} onClick={() => void saveProfileSecret()} type="button"><Save size={16} />{busy === "profile-secret" ? "加密保存中…" : selectedProfile.hasAccessToken ? "轮换密钥" : "加密保存"}</button>{selectedProfileReady && <button className="danger-button" disabled={!canManageAccounts || busy !== null} onClick={() => void deleteProfileSecret()} type="button"><Trash2 size={15} />删除密钥</button>}</div>
            </div>}
          </div>
        </div>
      </section>

      <section className="connection-section meta-binding-section">
        <div className="connection-subheading"><span className="connection-subheading-icon"><Link2 size={18} /></span><div><h3>广告账户绑定</h3><p>账户只引用共享档案，并保存 Ad Account ID、可选 Page ID 与 liveMode；不重复保存 App 或 Token。</p></div></div>
        <form className="connection-form-block" noValidate onSubmit={(event) => void saveBinding(event)}>
          <div className="form-grid">
            <label className="field"><span>共享 App 档案</span><select aria-describedby={bindingErrors.profileId ? "meta-binding-profile-error" : undefined} aria-invalid={Boolean(bindingErrors.profileId)} required value={binding.profileId} onChange={(event) => { setBinding({ ...binding, profileId: event.target.value }); clearBindingError("profileId"); }}><option value="">请选择</option>{profiles.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.appId}</option>)}</select>{bindingErrors.profileId && <small className="error-text" id="meta-binding-profile-error" role="alert">{bindingErrors.profileId}</small>}</label>
            <label className="field"><span>广告账户 ID</span><input aria-describedby={bindingErrors.adAccountId ? "meta-binding-ad-account-error" : undefined} aria-invalid={Boolean(bindingErrors.adAccountId)} pattern="(?:act_)?[0-9]+" required placeholder="例如 act_1705718683974303" value={binding.adAccountId} onChange={(event) => { setBinding({ ...binding, adAccountId: event.target.value }); clearBindingError("adAccountId"); }} />{bindingErrors.adAccountId && <small className="error-text" id="meta-binding-ad-account-error" role="alert">{bindingErrors.adAccountId}</small>}</label>
            <label className="field"><span>Facebook Page ID（可选）</span><input aria-describedby={bindingErrors.pageId ? "meta-binding-page-error" : undefined} aria-invalid={Boolean(bindingErrors.pageId)} inputMode="numeric" pattern="[0-9]+" value={binding.pageId} onChange={(event) => { setBinding({ ...binding, pageId: event.target.value }); clearBindingError("pageId"); }} />{bindingErrors.pageId && <small className="error-text" id="meta-binding-page-error" role="alert">{bindingErrors.pageId}</small>}</label>
            <label className="field"><span>运行模式</span><select value={binding.liveMode} onChange={(event) => setBinding({ ...binding, liveMode: event.target.value as MetaMarketingApiLiveMode })}><option value="disabled">关闭（零网络）</option><option value="read-only">只读</option><option value="manual-status">手动启停</option><option value="automation-status">自动化启停</option></select></label>
            <label className="field"><span>广告创建</span><select value={binding.creationMode} onChange={(event) => setBinding({ ...binding, creationMode: event.target.value as MetaCreationMode })}><option value="disabled">关闭</option><option value="paused-only">仅创建已暂停广告（创建后不投放）</option></select></label>
          </div>
          <fieldset className="meta-level-fieldset"><legend>允许启停层级</legend>{(["campaign", "ad-group", "ad"] as const).map((entityType) => <label key={entityType}><input checked={binding.allowedStatusEntityTypes.includes(entityType)} type="checkbox" onChange={(event) => setBinding({ ...binding, allowedStatusEntityTypes: event.target.checked ? [...binding.allowedStatusEntityTypes, entityType] : binding.allowedStatusEntityTypes.filter((item) => item !== entityType) })} />{entityType === "campaign" ? "广告系列" : entityType === "ad-group" ? "广告组" : "广告"}</label>)}</fieldset>
          <div className="connection-inline-actions"><button className="secondary-button" disabled={!canManageAccounts || busy !== null} type="submit"><Save size={16} />{busy === "binding" ? "保存中…" : "保存账户绑定"}</button></div>
        </form>

        {selectedProfile && <div className="connection-form-block meta-discovery-block">
          <div className="meta-form-heading"><div><h3>{selectedProfile.businessId ? "发现 Business 下属广告账户" : "发现 Token 可访问的广告账户"}</h3><p>{selectedProfile.businessId ? "按可选 BM ID 查询 owned ad accounts。" : "未填写 BM，将通过 /me/adaccounts 查询。"} 只有点击按钮时才会调用 Meta。</p></div><button className="secondary-button" disabled={!selectedProfileReady || busy !== null} onClick={() => void discoverAdAccounts()} type="button"><Search size={15} />{busy === "discover" ? "发现中…" : "发现广告账户"}</button></div>
          {discoveredAccounts.length > 0 && <div className="meta-discovered-list">{discoveredAccounts.map((item) => {
            const active = item.accountStatus === 1;
            return <button disabled={!active} key={item.adAccountId} onClick={() => { setBinding({ ...binding, profileId: selectedProfile.id, adAccountId: item.adAccountId.startsWith("act_") ? item.adAccountId : `act_${item.adAccountId}` }); clearBindingError("profileId"); clearBindingError("adAccountId"); }} title={active ? "选择此广告账户" : `账户状态 ${item.accountStatus}，不可接入`} type="button"><strong>{item.name}</strong><small>{item.adAccountId} · {item.currency || "币种未知"} · {item.timezone || "时区未知"} · {active ? "可用" : `不可用（${item.accountStatus}）`}</small></button>;
          })}</div>}
        </div>}
      </section>

      <section className="connection-section">
        <div className="connection-observability-grid">
          <div className="connection-form-block"><div className="connection-subheading"><span className="connection-subheading-icon"><Activity size={18} /></span><div><h3>显式连接与同步</h3><p>页面加载只读取本地状态，不会调用 Meta。</p></div></div><div className="connection-security-list"><span><CheckCircle2 size={15} />账户绑定档案：{bindingProfile ? `${bindingProfile.name}（引用 ${bindingProfile.referenceCount}）` : "未绑定"}</span><span><CheckCircle2 size={15} />密钥：{bindingProfileReady ? "Secret / Token 已加密保存" : "未完整保存"}</span><span><LockKeyhole size={15} />调度：{binding.liveMode === "automation-status" ? "需 Meta 运行开关与账户开关共同授权" : "关闭"}</span>{lastSyncMessage && <span><RefreshCcw size={15} />{lastSyncMessage}</span>}</div><div className="connection-inline-actions"><button className="secondary-button" disabled={!connection || !bindingProfileReady || busy !== null} onClick={() => void testConnection()} type="button"><Activity size={15} />{busy === "test" ? "检测中…" : "检测连接"}</button><button className="primary-button" disabled={!readReady || busy !== null} onClick={() => void syncReadOnly()} type="button"><RefreshCcw size={15} />{busy === "sync" ? "同步中…" : "只读同步"}</button></div></div>
          <div className="connection-form-block"><div className="connection-subheading"><span className="connection-subheading-icon"><ShieldCheck size={18} /></span><div><h3>当前能力</h3><p>能力由连接检测、运行模式与账户授权共同决定。</p></div></div><div className="connection-security-list"><span>连接：{connection?.status === "ready" ? "正常" : connection?.status === "failed" ? "失败" : "未配置"}</span><span>授权：{connection?.authorizationStatus === "active" ? "有效" : connection?.authorizationStatus === "failed" ? "失败" : "未确认"}</span><span>能力：{availableCapabilities.length ? availableCapabilities.map((item) => item.capability).join("、") : "无"}</span></div></div>
        </div>
      </section>
    </section>
  );
}

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Meta 接入发生未知错误。";
}
