(() => {
  "use strict";
  const state = { csrf: null, section: "invitations", quotaAccount: null };
  const byId = (id) => document.getElementById(id);
  const status = (message, error = false) => { const node = byId("global-status"); node.textContent = message; node.style.color = error ? "#c94f45" : ""; };
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const formatDate = (value) => value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-";
  const formatBytes = (value) => { const bytes = Number(value); return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GiB` : `${(bytes / 1048576).toFixed(1)} MiB`; };

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (options.method && options.method !== "GET") headers["X-Chimera-CSRF"] = state.csrf;
    const response = await fetch(path, { credentials: "same-origin", ...options, headers });
    if (response.status === 401) { showLogin(); throw new Error("会话已失效"); }
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || "请求失败");
    return response.status === 204 ? null : response.json();
  }

  function clearInviteCode() { byId("invite-code-value").textContent = ""; byId("invite-code").hidden = true; }
  function showLogin() { state.csrf = null; clearInviteCode(); byId("app-view").hidden = true; byId("login-view").hidden = false; byId("password").focus(); }
  function showApp() { byId("login-view").hidden = true; byId("app-view").hidden = false; switchSection("invitations"); }

  async function loadInvitations() {
    const rows = byId("invitation-rows"); rows.replaceChildren();
    const invitations = await api("/chimera-control/api/invitations");
    if (!invitations.length) { const cell = el("td", "暂无邀请码"); cell.colSpan = 5; const row = el("tr"); row.append(cell); rows.append(row); return; }
    invitations.forEach((invitation) => {
      const row = el("tr");
      const revoked = Boolean(invitation.revokedAt); const exhausted = invitation.usedCount >= invitation.maxUses;
      [invitation.label || "-", `${invitation.usedCount}/${invitation.maxUses}`, formatDate(invitation.expiresAt)].forEach((value) => row.append(el("td", value)));
      row.append(el("td", revoked ? "已撤销" : exhausted ? "已用完" : "可用", revoked ? "status-revoked" : "status-active"));
      const actions = el("td", undefined, "row-actions");
      if (!revoked) { const revoke = el("button", "撤销", "button-secondary"); revoke.type = "button"; revoke.addEventListener("click", () => mutateInvitation(invitation.id, revoke)); actions.append(revoke); }
      row.append(actions); rows.append(row);
    });
  }

  async function mutateInvitation(id, button) {
    button.disabled = true;
    try { await api(`/chimera-control/api/invitations/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" }); status("邀请码已撤销"); await loadInvitations(); }
    catch (error) { status(error.message, true); button.disabled = false; }
  }

  async function loadAnnouncement() {
    const config = await api("/chimera-control/api/config"); const form = byId("announcement-form"); const value = config.announcement;
    for (const name of ["title", "body", "primaryButtonLabel"]) form.elements[name].value = value[name] || "";
    form.elements.enabled.checked = value.enabled; form.elements.linkButtonLabel.value = value.linkButtonLabel || ""; form.elements.linkUrl.value = value.linkUrl || "";
  }

  async function loadAccounts() {
    const rows = byId("account-rows"); rows.replaceChildren(); const accounts = await api("/chimera-control/api/accounts");
    if (!accounts.length) { const cell = el("td", "暂无账户"); cell.colSpan = 6; const row = el("tr"); row.append(cell); rows.append(row); return; }
    accounts.forEach((account) => {
      const row = el("tr"); const identity = el("td"); identity.append(el("code", account.id)); row.append(identity);
      [formatDate(account.createdAt), formatBytes(account.attachmentUsedBytes), formatBytes(account.attachmentQuotaBytes)].forEach((value) => row.append(el("td", value)));
      row.append(el("td", account.disabled ? "已禁用" : "正常", account.disabled ? "status-disabled" : "status-active"));
      const actions = el("td", undefined, "row-actions");
      const toggle = el("button", account.disabled ? "恢复" : "禁用", "button-secondary"); toggle.type = "button"; toggle.addEventListener("click", () => accountAction(account, account.disabled ? "restore" : "disable", toggle));
      const revoke = el("button", "撤销令牌", "button-secondary"); revoke.type = "button"; revoke.addEventListener("click", () => accountAction(account, "revoke-tokens", revoke));
      const quota = el("button", "配额", "button-secondary"); quota.type = "button"; quota.addEventListener("click", () => openQuota(account));
      actions.append(toggle, revoke, quota); row.append(actions); rows.append(row);
    });
  }

  async function accountAction(account, action, button) {
    button.disabled = true;
    try { await api(`/chimera-control/api/accounts/${account.id}/${action}`, { method: "POST", body: "{}" }); status("账户策略已更新"); await loadAccounts(); }
    catch (error) { status(error.message, true); button.disabled = false; }
  }
  function openQuota(account) {
    state.quotaAccount = account;
    byId("quota-form").elements.quotaGiB.value = String(Number(account.attachmentQuotaBytes) / 1073741824);
    byId("quota-dialog").showModal();
  }

  async function switchSection(section) {
    clearInviteCode(); state.section = section;
    document.querySelectorAll("[data-section]").forEach((node) => { node.hidden = node.dataset.section !== section; });
    document.querySelectorAll("[data-target]").forEach((button) => { if (button.dataset.target === section) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
    status("");
    try { if (section === "invitations") await loadInvitations(); else if (section === "announcement") await loadAnnouncement(); else await loadAccounts(); }
    catch (error) { status(error.message, true); }
  }

  byId("login-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; byId("login-error").textContent = "";
    try { const result = await api("/chimera-control/api/session", { method: "POST", body: JSON.stringify({ password: byId("password").value }) }); state.csrf = result.csrfToken; byId("password").value = ""; showApp(); }
    catch { byId("login-error").textContent = "登录失败"; }
    finally { button.disabled = false; }
  });
  byId("invite-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget; const button = event.submitter; button.disabled = true;
    try { const result = await api("/chimera-control/api/invitations", { method: "POST", body: JSON.stringify({ label: form.elements.label.value || null, maxUses: Number(form.elements.maxUses.value), expiresAt: new Date(form.elements.expiresAt.value).toISOString() }) }); byId("invite-code-value").textContent = result.code; byId("invite-code").hidden = false; status("邀请码已创建"); await loadInvitations(); }
    catch (error) { status(error.message, true); } finally { button.disabled = false; }
  });
  byId("announcement-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget; const button = event.submitter; button.disabled = true;
    const linkLabel = form.elements.linkButtonLabel.value.trim(); const linkUrl = form.elements.linkUrl.value.trim();
    const payload = { announcement: { enabled: form.elements.enabled.checked, title: form.elements.title.value, body: form.elements.body.value, primaryButtonLabel: form.elements.primaryButtonLabel.value, linkButtonLabel: linkLabel || null, linkUrl: linkUrl || null }, androidUpdateManifestPath: "/downloads/chimera-update.json" };
    try { await api("/chimera-control/api/config", { method: "PUT", body: JSON.stringify(payload) }); status("启动公告已保存"); }
    catch (error) { status(error.message, true); } finally { button.disabled = false; }
  });
  byId("quota-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget; const button = event.submitter; const account = state.quotaAccount; if (!account) return;
    const bytes = Number(form.elements.quotaGiB.value) * 1073741824;
    if (!Number.isSafeInteger(bytes)) { status("请输入有效配额", true); return; }
    button.disabled = true;
    try { await api(`/chimera-control/api/accounts/${account.id}/quota`, { method: "PUT", body: JSON.stringify({ attachmentQuotaBytes: bytes }) }); byId("quota-dialog").close(); state.quotaAccount = null; status("附件配额已更新"); await loadAccounts(); }
    catch (error) { status(error.message, true); } finally { button.disabled = false; }
  });
  byId("cancel-quota").addEventListener("click", () => { byId("quota-dialog").close(); state.quotaAccount = null; });
  byId("copy-invite").addEventListener("click", async () => { await navigator.clipboard.writeText(byId("invite-code-value").textContent); status("邀请码已复制"); });
  byId("dismiss-invite").addEventListener("click", clearInviteCode);
  byId("refresh-accounts").addEventListener("click", () => switchSection("accounts"));
  document.querySelectorAll("[data-target]").forEach((button) => button.addEventListener("click", () => switchSection(button.dataset.target)));
  byId("logout").addEventListener("click", async () => { try { await api("/chimera-control/api/session", { method: "DELETE" }); } finally { showLogin(); } });
  window.addEventListener("beforeunload", clearInviteCode);
  showLogin();
})();
