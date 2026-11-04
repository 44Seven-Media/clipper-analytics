/* Live page: sign-in, the dashboard, and the Accounts tab with Connect buttons.
   Talks to Supabase with the public anon key; row-level security only lets team members read anything. */
(function () {
  "use strict";
  const CFG = window.CLIPPER_CONFIG || {};
  const configured = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase);
  const params = new URLSearchParams(location.search);
  const sampleMode = params.has("sample");
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
  function show(view) {
    for (const v of ["login", "notteam", "dashboard", "accounts"]) $("view-" + v).hidden = v !== view;
    $("topbar").hidden = !(view === "dashboard" || view === "accounts");
    $("nav-dashboard").setAttribute("aria-current", view === "dashboard" ? "page" : "false");
    $("nav-accounts").setAttribute("aria-current", view === "accounts" ? "page" : "false");
  }
  function route() { return location.hash === "#accounts" ? "accounts" : "dashboard"; }

  // ---------- data ----------
  let session = null, accounts = [], dashData = null;

  async function loadSample() {
    const r = await fetch("sample.json", { cache: "no-store" });
    dashData = await r.json();
    accounts = dashData.accounts.map(a => ({ id: a.id, name: a.name, platform: a.platform, handle: a.handle,
      group_name: a.group, connection: a.platform === "x" || a.platform === "youtube" ? "handle" : "oauth",
      active: true, last_success: a.lastSuccess, connection_expires: null }));
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
    $("sampleNotice").hidden = !sampleMode;
    const grid = $("connectGrid"); grid.replaceChildren();
    for (const c of CONNECT) {
      const n = accounts.filter(a => c.plats.includes(a.platform) && a.connection === "oauth").length;
      grid.append(h("div", { class: "connect" },
        h("h3", null, c.plats.map(p => h("span", { class: "sw", style: `background:var(--s-${p})` })), c.title),
        h("p", null, c.text),
        h("div", { class: "count" }, n ? `${n} connected` : "None connected yet"),
        h("button", { type: "button", class: "btn-primary", id: "connect-" + c.id, disabled: sampleMode,
          onclick: e => startConnect(c.id, e.currentTarget) }, n ? "Connect another" : "Connect")));
    }
    const groups = [...new Set(accounts.map(a => a.group_name).filter(Boolean))].sort();
    $("groupList").replaceChildren(...groups.map(g => h("option", { value: g })));
    $("hfSubmit").disabled = sampleMode;

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
    const toggle = h("input", { type: "checkbox", id: `active-${a.id}`, checked: a.active, disabled: sampleMode,
      onchange: e => setActive(a, e.target.checked, e.target) });
    tr.append(
      h("td", { class: "l" }, h("div", { class: "acct" }, h("div", null, h("b", null, a.name), h("small", null, handle)))),
      h("td", { class: "l" }, plat),
      h("td", { class: "l" }, a.group_name || h("span", { class: "muted" }, "–")),
      h("td", { class: "l" }, connectionPill(a)),
      h("td", { class: "l" }, fmtDate(a.last_success)),
      h("td", { class: "l" }, h("label", { class: "switch", for: `active-${a.id}` }, toggle, a.active ? "On" : "Paused")),
      h("td", null, h("div", { class: "actions" },
        h("button", { type: "button", class: "btn", disabled: sampleMode, onclick: () => tr.replaceWith(accountRow(a, true)) }, "Edit"),
        h("button", { type: "button", class: "btn danger", disabled: sampleMode, onclick: e => confirmRemove(a, e.currentTarget) }, "Remove"))));
    return tr;
  }

  // ---------- actions ----------
  async function startConnect(platform, btn) {
    btn.disabled = true; const label = btn.textContent; btn.textContent = "Opening…";
    try {
      const { data, error } = await sb.functions.invoke("connect-start", { body: { platform } });
      if (error) {
        let msg = error.message;
        try { msg = (await error.context.json()).error || msg; } catch (e) { /* keep generic */ }
        throw new Error(msg);
      }
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
  $("signOut").addEventListener("click", () => { if (sampleMode) { location.href = location.pathname; } else signOut(); });
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
    if (sampleMode) {
      $("whoEmail").textContent = "Sample data";
      $("signOut").textContent = configured ? "Leave sample" : "Back";
      try { await loadSample(); } catch (e) { toast("Couldn't load the sample data.", true); return; }
      return navigate();
    }
    if (!sb || !session || settingPassword) return showLogin();
    $("whoEmail").textContent = session.user.email;
    const { data: onTeam, error } = await sb.rpc("is_team");
    if (error || !onTeam) {
      $("notTeamEmail").textContent = session.user.email;
      $("notTeamSql").textContent = `insert into team_members (email) values ('${session.user.email.toLowerCase().replace(/'/g, "''")}');`;
      return show("notteam");
    }
    try { await loadLive(); } catch (e) { toast(`Couldn't load the numbers: ${e.message}`, true); return; }
    navigate();
  }

  function navigate() {
    const v = route();
    if (v === "accounts") renderAccounts(); else renderDashboard();
    show(v);
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", () => { if (dashData && (session || sampleMode)) navigate(); });

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

  if (!sb || sampleMode) { if (sampleMode) enter(); else showLogin(); }
  else {
    sb.auth.onAuthStateChange((event, s) => {
      const changed = (s && s.user && s.user.id) !== (session && session.user && session.user.id);
      session = s;
      if (event === "PASSWORD_RECOVERY") { settingPassword = true; return showLogin(); }
      if (event === "INITIAL_SESSION" || event === "SIGNED_OUT" || (event === "SIGNED_IN" && changed)) setTimeout(enter);
    });
  }
})();
