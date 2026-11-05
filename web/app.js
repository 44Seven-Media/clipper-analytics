/* Live page: sign-in, the dashboard, and the Accounts tab with Connect buttons.
   Talks to Supabase with the public anon key; row-level security only lets team members read anything. */
(function () {
  "use strict";
  const CFG = window.CLIPPER_CONFIG || {};
  const configured = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase);
  const params = new URLSearchParams(location.search);
  const sb = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;
  const inviteLink = /type=(invite|recovery)/.test(location.hash);

  const PLATFORMS = { facebook: "Facebook", tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", x: "X" };
  const CONNECT = [
    { id: "meta", title: "Facebook & Instagram", plats: ["facebook", "instagram"],
      text: "Sign in with Facebook once. Every Page you pick is added, with the Instagram account linked to it." },
    { id: "tiktok", title: "TikTok", plats: ["tiktok"], text: "Sign in as the TikTok account. Repeat for each one; log out of TikTok in between." },
    { id: "youtube", title: "YouTube", plats: ["youtube"], text: "Sign in with Google and pick the channel. Brand channels appear on Google's chooser." },
    { id: "x", title: "X", plats: ["x"], text: "Sign in as the X account. Repeat for each one." },
  ];

  const $ = id => document.getElementById(id);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.setAttribute("style", v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "checked" || k === "disabled") el[k] = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const fmtDate = s => s ? dateFmt.format(new Date(s.slice(0, 10) + "T00:00:00Z")) : "Not yet";

  let toastTimer = null;
  function toast(msg, isError) {
    const t = $("toast");
    t.textContent = msg; t.className = "toast" + (isError ? " error" : ""); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 9000 : 5000);
  }
  const VIEWS = ["login", "notteam", "dashboard", "accounts", "settings"];
  function show(view) {
    for (const v of VIEWS) $("view-" + v).hidden = v !== view;
    $("topbar").hidden = !["dashboard", "accounts", "settings"].includes(view);
    for (const v of ["dashboard", "accounts", "settings"]) $("nav-" + v).setAttribute("aria-current", view === v ? "page" : "false");
  }
  function route() {
    const want = { "#accounts": "accounts", "#settings": "settings" }[location.hash] || "dashboard";
    return want !== "dashboard" && role !== "admin" ? "dashboard" : want;
  }

  // ---------- data ----------
  let session = null, accounts = [], dashData = null, role = null, settings = null;

  async function callFn(name, body) {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error || msg; } catch (e) { /* keep generic */ }
      throw new Error(msg);
    }
    return data;
  }
  const PLATFORM_KEYS = { meta: "meta", tiktok: "tiktok", youtube: "youtube", x: "x" };
  function platformReady(id) {
    if (!settings) return null;
    const f = settings.platforms[PLATFORM_KEYS[id]] || [];
    const need = id === "youtube" ? ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] : id === "x" ? ["X_CLIENT_ID", "X_CLIENT_SECRET"]
      : id === "meta" ? ["META_APP_ID", "META_APP_SECRET"] : f.map(x => x.key);
    return need.every(k => (f.find(x => x.key === k) || {}).saved);
  }

  async function loadLive() {
    const [d, a] = await Promise.all([
      sb.rpc("dashboard_data"),
      sb.from("accounts").select("id,name,platform,handle,group_name,connection,connection_expires,active,last_success,profile_url").order("platform").order("name"),
    ]);
    if (d.error) throw d.error;
    if (a.error) throw a.error;
    dashData = d.data; accounts = a.data;
  }

  // ---------- views ----------
  function renderDashboard() {
    ClipperDashboard.mount($("view-dashboard"), dashData, {
      emptyHint: "Connect your clipper accounts on the Accounts tab. Charts appear after the next daily update.",
      waitingHint: "Accounts are connected. The first numbers arrive with the next daily update at about 6 AM Central, and growth lines fill in day by day.",
      onAddAccounts: () => { location.hash = "accounts"; },
    });
  }

  function renderAccounts() {
    const grid = $("connectGrid"); grid.replaceChildren();
    for (const c of CONNECT) {
      const n = accounts.filter(a => c.plats.includes(a.platform) && a.connection === "oauth").length;
      grid.append(h("div", { class: "connect" },
        h("h3", null, c.plats.map(p => h("span", { class: "sw", style: `background:var(--s-${p})` })), c.title),
        h("p", null, c.text),
        h("div", { class: "count" }, n ? `${n} connected` : "None connected yet"),
        platformReady(c.id) === false
          ? h("a", { class: "btn", href: "#settings", id: "setup-" + c.id }, "Set up in Settings")
          : h("button", { type: "button", class: "btn-primary", id: "connect-" + c.id,
              onclick: e => startConnect(c.id, e.currentTarget) }, n ? "Connect another" : "Connect")));
    }
    const groups = [...new Set(accounts.map(a => a.group_name).filter(Boolean))].sort();
    $("groupList").replaceChildren(...groups.map(g => h("option", { value: g })));

    const rows = $("accRows"); rows.replaceChildren();
    $("accEmpty").hidden = accounts.length > 0;
    $("accCount").textContent = accounts.length ? `Tracked accounts (${accounts.length})` : "Tracked accounts";
    for (const a of accounts) rows.append(accountRow(a));
  }

  function connectionPill(a) {
    if (a.connection === "handle") return h("span", { class: "pill off" }, h("i"), "Handle only");
    if (a.connection_expires) {
      const days = Math.round((new Date(a.connection_expires) - Date.now()) / 864e5);
      if (days < 0) return h("span", { class: "pill bad", title: "Reconnect this account" }, h("i"), "Login expired");
      if (days < 30) return h("span", { class: "pill warn", title: `Login expires in ${days} days` }, h("i"), `Expires in ${days}d`);
    }
    return h("span", { class: "pill ok" }, h("i"), "Login");
  }

  function accountRow(a, editing) {
    const tr = h("tr", { id: "acc-" + a.id });
    const plat = h("span", { class: "pill" }, h("span", { class: "sw", style: `background:var(--s-${a.platform})` }), PLATFORMS[a.platform] || a.platform);
    const handle = a.platform === "facebook" ? `Page ${a.handle}` : (a.platform === "youtube" && /^UC/.test(a.handle) ? a.handle : "@" + a.handle);
    if (editing) {
      const name = h("input", { id: `edit-name-${a.id}`, value: a.name, "aria-label": "Name" });
      const group = h("input", { id: `edit-group-${a.id}`, value: a.group_name || "", "aria-label": "Group", list: "groupList" });
      tr.className = "edit-row";
      tr.append(h("td", { class: "l" }, name), h("td", { class: "l" }, plat), h("td", { class: "l" }, group),
        h("td", { class: "l" }, connectionPill(a)), h("td", { class: "l" }, fmtDate(a.last_success)), h("td", { class: "l" }),
        h("td", null, h("div", { class: "actions" },
          h("button", { type: "button", class: "btn", onclick: () => saveEdit(a, name.value, group.value) }, "Save"),
          h("button", { type: "button", class: "btn", onclick: () => tr.replaceWith(accountRow(a)) }, "Cancel"))));
      setTimeout(() => name.focus());
      return tr;
    }
    const toggle = h("input", { type: "checkbox", id: `active-${a.id}`, checked: a.active,
      onchange: e => setActive(a, e.target.checked, e.target) });
    tr.append(
      h("td", { class: "l" }, h("div", { class: "acct" }, h("div", null, h("b", null, a.name), h("small", null, handle)))),
      h("td", { class: "l" }, plat),
      h("td", { class: "l" }, a.group_name || h("span", { class: "muted" }, "–")),
      h("td", { class: "l" }, connectionPill(a)),
      h("td", { class: "l" }, fmtDate(a.last_success)),
      h("td", { class: "l" }, h("label", { class: "switch", for: `active-${a.id}` }, toggle, a.active ? "On" : "Paused")),
      h("td", null, h("div", { class: "actions" },
        h("button", { type: "button", class: "btn", onclick: () => tr.replaceWith(accountRow(a, true)) }, "Edit"),
        h("button", { type: "button", class: "btn danger", onclick: e => confirmRemove(a, e.currentTarget) }, "Remove"))));
    return tr;
  }

  // ---------- actions ----------
  async function startConnect(platform, btn) {
    btn.disabled = true; const label = btn.textContent; btn.textContent = "Opening…";
    try {
      const data = await callFn("connect-start", { platform });
      location.href = data.url;
    } catch (e) {
      toast(e.message || "Couldn't start the sign-in.", true);
      btn.disabled = false; btn.textContent = label;
    }
  }

  async function saveEdit(a, name, group) {
    name = name.trim(); group = group.trim();
    if (!name) { toast("Give the account a name.", true); return; }
    const { error } = await sb.from("accounts").update({ name, group_name: group }).eq("id", a.id);
    if (error) { toast(`Couldn't save: ${error.message}`, true); return; }
    Object.assign(a, { name, group_name: group });
    $("acc-" + a.id).replaceWith(accountRow(a));
    toast("Saved");
    refreshDashboardSoon();
  }

  async function setActive(a, on, input) {
    input.disabled = true;
    const { error } = await sb.from("accounts").update({ active: on }).eq("id", a.id);
    input.disabled = false;
    if (error) { input.checked = !on; toast(`Couldn't update: ${error.message}`, true); return; }
    a.active = on;
    $("acc-" + a.id).replaceWith(accountRow(a));
    toast(on ? `${a.name} is tracked again` : `${a.name} is paused`);
    refreshDashboardSoon();
  }

  function confirmRemove(a, btn) {
    const cell = btn.parentElement;
    cell.replaceChildren(
      h("span", { class: "muted", style: "font-size:12.5px" }, "This also deletes its history."),
      h("button", { type: "button", class: "btn danger", onclick: () => remove(a) }, "Remove"),
      h("button", { type: "button", class: "btn", onclick: () => { $("acc-" + a.id).replaceWith(accountRow(a)); } }, "Keep"));
  }

  async function remove(a) {
    const { error } = await sb.from("accounts").delete().eq("id", a.id);
    if (error) { toast(`Couldn't remove: ${error.message}`, true); return; }
    accounts = accounts.filter(x => x.id !== a.id);
    renderAccounts();
    toast(`Removed ${a.name}`);
    refreshDashboardSoon();
  }

  $("handleForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("hfError"); err.hidden = true;
    const platform = $("hfPlatform").value;
    const handle = $("hfHandle").value.trim().replace(/^https?:\/\/(www\.)?(youtube\.com|x\.com|twitter\.com)\//i, "").replace(/\/.*$/, "");
    const name = $("hfName").value.trim();
    const group = $("hfGroup").value.trim();
    if (!handle || !name) { err.textContent = "Enter the handle and a name."; err.hidden = false; return; }
    $("hfSubmit").disabled = true;
    const { data, error } = await sb.from("accounts").insert({ platform, handle, name, group_name: group }).select().single();
    $("hfSubmit").disabled = false;
    if (error) {
      err.textContent = error.code === "23505" ? "That account is already tracked." : `Couldn't add it: ${error.message}`;
      err.hidden = false; return;
    }
    accounts.push(data);
    $("handleForm").reset();
    renderAccounts();
    toast(`Added ${name}. Its numbers arrive with the next daily update.`);
    refreshDashboardSoon();
  });

  let refreshTimer = null;
  function refreshDashboardSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => { try { await loadLive(); if (route() === "dashboard") renderDashboard(); } catch (e) { /* next visit */ } }, 400);
  }


  // ---------- settings ----------
  const SETUP = [
    { id: "meta", title: "Facebook & Instagram", plats: ["facebook", "instagram"], steps: [
      ["Go to ", ["Meta for Developers", "https://developers.facebook.com/apps"], " → Create app. Pick ", ["b", "Other"], ", then ", ["b", "Business"], ", and link your business portfolio."],
      ["Add the product ", ["b", "Facebook Login for Business"], ". In its Settings, paste the callback URL into ", ["b", "Valid OAuth Redirect URIs"], "."],
      ["Facebook Login for Business → Configurations: create one with a ", ["b", "User access token"], " and the permissions pages_show_list, pages_read_engagement, read_insights, instagram_basic, instagram_manage_insights and business_management. Copy its ", ["b", "Configuration ID"], " here."],
      ["Open App settings → Basic and copy the ", ["b", "App ID"], " and ", ["b", "App secret"], " here."],
      ["Each Instagram account must be a Business or Creator account linked to its Facebook Page."],
      ["While the app is in development mode, whoever clicks Connect needs a role on the app (Admin, Developer or Tester)."],
    ] },
    { id: "tiktok", title: "TikTok", plats: ["tiktok"], steps: [
      ["Go to ", ["TikTok for Developers", "https://developers.tiktok.com/apps"], " → Connect an app."],
      ["Add ", ["b", "Login Kit"], " with the scopes user.info.basic, user.info.profile, user.info.stats and video.list."],
      ["Under Login Kit, add the callback URL as a ", ["b", "Redirect URI"], "."],
      ["Copy the ", ["b", "Client key"], " and ", ["b", "Client secret"], " here."],
      ["Submit the app for review. Until it's approved, add your TikTok accounts as Sandbox target users."],
    ] },
    { id: "youtube", title: "YouTube", plats: ["youtube"], steps: [
      ["In ", ["Google Cloud console", "https://console.cloud.google.com/apis/library/youtube.googleapis.com"], ", create a project and enable ", ["b", "YouTube Data API v3"], "."],
      ["Credentials → Create credentials → ", ["b", "API key"], ". Restrict it to YouTube Data API v3 and paste it here. The daily update uses it."],
      ["OAuth consent screen: choose External and add yourself as a test user."],
      ["Credentials → Create credentials → ", ["b", "OAuth client ID"], " → Web application. Add the callback URL under Authorized redirect URIs, then copy the client ID and secret here."],
    ] },
    { id: "x", title: "X", plats: ["x"], steps: [
      ["In the ", ["X developer console", "https://console.x.com"], ", create a project and app, and add credits. X bills per request."],
      ["User authentication settings: turn on ", ["b", "OAuth 2.0"], ", type ", ["b", "Web App"], ", with the callback URL, and this page as the website."],
      ["Keys and tokens: copy the ", ["b", "OAuth 2.0 Client ID"], " and ", ["b", "Client Secret"], ", and the ", ["b", "Bearer Token"], " (the daily update uses it)."],
    ] },
  ];
  function richLine(parts) {
    return parts.map(p => typeof p === "string" ? p : p[0] === "b" ? h("b", null, p[1])
      : h("a", { href: p[1], target: "_blank", rel: "noopener noreferrer" }, p[0] + " ↗"));
  }
  function statusPill(fields) {
    const saved = fields.filter(f => f.saved).length;
    if (saved === fields.length) return h("span", { class: "pill ok" }, h("i"), "Ready");
    if (saved) return h("span", { class: "pill warn" }, h("i"), "Partly set up");
    return h("span", { class: "pill off" }, h("i"), "Not set up");
  }
  function setupCard(def) {
    const fields = settings.platforms[def.id];
    const inputs = {};
    const msg = h("p", { class: "setup-msg", "aria-live": "polite" });
    const fieldEls = fields.map(f => {
      const id = `set-${f.key}`;
      const input = h("input", { id, type: f.secret ? "password" : "text", autocomplete: "off", spellcheck: "false",
        value: f.secret ? "" : f.value, placeholder: f.secret && f.saved ? "Saved · enter a new value to replace" : "" });
      inputs[f.key] = input;
      return h("div", { class: "field" }, h("label", { for: id }, f.label), input);
    });
    const save = h("button", { type: "submit", class: "btn-primary", id: `save-${def.id}` }, "Save");
    const checkBtn = h("button", { type: "button", class: "btn", id: `check-${def.id}`, disabled: !fields.some(f => f.saved),
      onclick: async () => {
        checkBtn.disabled = true; msg.className = "setup-msg"; msg.textContent = "Checking…";
        try { const r = await callFn("settings", { action: "check", platform: def.id });
              msg.className = "setup-msg " + (r.ok ? "good" : "bad"); msg.textContent = r.message; }
        catch (e) { msg.className = "setup-msg bad"; msg.textContent = e.message; }
        checkBtn.disabled = false;
      } }, "Check keys");
    const clear = h("button", { type: "button", class: "linkbtn", id: `clear-${def.id}`, hidden: !fields.some(f => f.saved),
      onclick: async () => {
        if (clear.dataset.armed !== "1") { clear.dataset.armed = "1"; clear.textContent = "Click again to remove these keys"; return; }
        try { settings = await callFn("settings", { action: "save", values: Object.fromEntries(fields.map(f => [f.key, ""])) });
              renderSettingsCards(def.id); toast(`Removed ${def.title} keys`); }
        catch (e) { toast(e.message, true); }
      } }, "Remove keys");
    const form = h("form", { class: "setup-fields", novalidate: true, onsubmit: async e => {
      e.preventDefault();
      const values = {};
      for (const f of fields) {
        const v = inputs[f.key].value.trim();
        if (f.secret ? v !== "" : v !== f.value) values[f.key] = v;
      }
      if (!Object.keys(values).length) { msg.className = "setup-msg"; msg.textContent = "Nothing changed."; return; }
      save.disabled = true;
      try { settings = await callFn("settings", { action: "save", values }); renderSettingsCards(def.id); toast(`Saved ${def.title} keys`); }
      catch (err) { msg.className = "setup-msg bad"; msg.textContent = err.message; save.disabled = false; }
    } }, fieldEls, h("div", { class: "setup-actions" }, save, checkBtn, clear), msg);
    const ready = fields.every(f => f.saved);
    return h("details", { class: "setup", id: `setup-card-${def.id}`, open: !ready ? true : null },
      h("summary", null, h("h3", null, def.plats.map(p => h("span", { class: "sw", style: `background:var(--s-${p})` })), def.title), statusPill(fields)),
      h("div", { class: "setup-body" }, h("ol", null, def.steps.map(st => h("li", null, richLine(st)))), form));
  }
  function renderSettingsCards(keepOpen) {
    $("callbackUrl").textContent = settings.callbackUrl;
    const list = $("setupList");
    list.replaceChildren(...SETUP.map(setupCard));
    if (keepOpen) { const c = $(`setup-card-${keepOpen}`); if (c) c.open = true; }
  }
  $("copyCallback").addEventListener("click", async () => {
    const text = $("callbackUrl").textContent;
    try { await navigator.clipboard.writeText(text); toast("Callback URL copied"); }
    catch (e) { const r = document.createRange(); r.selectNodeContents($("callbackUrl")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast("Selected. Press ⌘C to copy."); }
  });

  async function renderTeam() {
    const rows = $("teamRows");
    let data;
    try { data = await callFn("settings", { action: "team" }); } catch (e) { toast(e.message, true); return; }
    const signedIn = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
    rows.replaceChildren(...data.members.map(m => {
      const isMe = m.email === data.me;
      const sel = h("select", { id: `role-${m.email}`, "aria-label": `Role for ${m.email}`, disabled: isMe,
        onchange: async e => {
          try { toast((await callFn("settings", { action: "role", email: m.email, role: e.target.value })).message); }
          catch (err) { toast(err.message, true); e.target.value = m.role; }
        } }, h("option", { value: "viewer" }, "Viewer"), h("option", { value: "admin" }, "Admin"));
      sel.value = m.role;
      const actions = h("div", { class: "actions" });
      if (!isMe) actions.append(h("button", { type: "button", class: "btn danger", onclick: e => {
        const b = e.currentTarget;
        if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Confirm remove"; return; }
        callFn("settings", { action: "remove", email: m.email }).then(r => { toast(r.message); renderTeam(); }, err => toast(err.message, true));
      } }, "Remove"));
      return h("tr", null,
        h("td", { class: "l" }, m.email, isMe ? h("span", { class: "muted" }, " (you)") : null),
        h("td", { class: "l" }, sel),
        h("td", { class: "l" }, m.lastSignIn ? signedIn.format(new Date(m.lastSignIn)) : (m.hasLogin ? "Never" : "Invite pending")),
        h("td", null, actions));
    }));
  }
  $("inviteForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("inviteError"); err.hidden = true;
    const email = $("inviteEmail").value.trim();
    if (!email) { err.textContent = "Enter an email."; err.hidden = false; return; }
    $("inviteBtn").disabled = true;
    try { const r = await callFn("settings", { action: "invite", email, role: $("inviteRole").value }); toast(r.message); $("inviteForm").reset(); renderTeam(); }
    catch (x) { err.textContent = x.message; err.hidden = false; }
    $("inviteBtn").disabled = false;
  });

  async function renderSettings() {
    if (!settings) { try { settings = await callFn("settings", { action: "get" }); } catch (e) { toast(e.message, true); return; } }
    renderSettingsCards();
    renderTeam();
  }

  // ---------- sign-in ----------
  $("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("loginError"); err.hidden = true;
    if (!configured) { err.textContent = "Sign-in isn't set up yet."; err.hidden = false; return; }
    $("loginBtn").disabled = true; $("loginBtn").textContent = "Signing in…";
    const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
    $("loginBtn").disabled = false; $("loginBtn").textContent = "Sign in";
    if (error) { err.textContent = error.message === "Invalid login credentials" ? "That email and password don't match." : error.message; err.hidden = false; }
  });
  $("forgotBtn").addEventListener("click", async () => {
    const err = $("loginError"); err.hidden = true;
    const email = $("email").value.trim();
    if (!email) { err.textContent = "Enter your email first, then click Forgot password."; err.hidden = false; return; }
    if (!configured) return;
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) { err.textContent = error.message; err.hidden = false; return; }
    toast("If that email is on the team, a reset link is on its way.");
  });
  $("newPassForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("newPassError"); err.hidden = true;
    const pw = $("newPassword").value;
    if (pw.length < 10) { err.textContent = "Use at least 10 characters."; err.hidden = false; return; }
    $("newPassBtn").disabled = true;
    const { error } = await sb.auth.updateUser({ password: pw });
    $("newPassBtn").disabled = false;
    if (error) { err.textContent = error.message; err.hidden = false; return; }
    toast("Password saved");
    settingPassword = false;
    enter();
  });
  async function signOut() { if (sb) await sb.auth.signOut(); location.hash = ""; }
  $("signOut").addEventListener("click", signOut);
  $("notTeamSignOut").addEventListener("click", signOut);
  $("notTeamRetry").addEventListener("click", () => enter());

  let settingPassword = inviteLink;
  function showLogin() {
    show("login");
    $("notConfigured").hidden = configured;
    $("loginForm").hidden = settingPassword;
    $("newPassForm").hidden = !settingPassword;
    $("authLead").textContent = settingPassword ? "Welcome. Choose a password to finish setting up your sign-in." :
      "Sign in to see followers, views and top clips across every clipper account.";
  }

  async function enter() {
    if (!sb || !session || settingPassword) return showLogin();
    $("whoEmail").textContent = session.user.email;
    const { data: myRole, error } = await sb.rpc("my_role");
    role = myRole || null;
    $("nav-accounts").hidden = $("nav-settings").hidden = role !== "admin";
    if (error || !role) {
      $("notTeamEmail").textContent = session.user.email;
      $("notTeamSql").textContent = `insert into team_members (email) values ('${session.user.email.toLowerCase().replace(/'/g, "''")}');`;
      return show("notteam");
    }
    try { await loadLive(); } catch (e) { toast(`Couldn't load the numbers: ${e.message}`, true); return; }
    if (role === "admin") { try { settings = await callFn("settings", { action: "get" }); } catch (e) { settings = null; } }
    navigate();
  }

  function navigate() {
    const v = route();
    if (v === "accounts") renderAccounts(); else if (v === "settings") renderSettings(); else renderDashboard();
    show(v);
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", () => { if (dashData && session) navigate(); });

  // Back from a platform's sign-in page.
  if (params.has("connected") || params.has("connect_error")) {
    if (params.has("connect_error")) toast(params.get("connect_error"), true);
    else {
      const n = Number(params.get("connected")), added = Number(params.get("added") || 0);
      toast(n === 0 ? "Nothing new was shared." :
        `${n} account${n === 1 ? "" : "s"} connected${added && added !== n ? ` (${added} new)` : ""}. Numbers arrive with the next daily update.`);
    }
    history.replaceState(null, "", location.pathname + "#accounts");
  }

  if (!sb) { showLogin(); }
  else {
    sb.auth.onAuthStateChange((event, s) => {
      const changed = (s && s.user && s.user.id) !== (session && session.user && session.user.id);
      session = s;
      if (event === "PASSWORD_RECOVERY") { settingPassword = true; return showLogin(); }
      if (event === "INITIAL_SESSION" || event === "SIGNED_OUT" || (event === "SIGNED_IN" && changed)) setTimeout(enter);
    });
  }
})();
