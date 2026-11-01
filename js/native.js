/* ============================================================
   native.js — the Capacitor layer (Android only; silently does nothing in a browser).
   Proven in Munazzim / Masareef / GymPlan / Dawa El Beit on a Xiaomi Mi 11X (Android 13, MIUI).

   The app talks to this file through window.MZApp (set it in the app):
     MZApp.back()              → true if it closed something (sheet, page…), false on the home page
     MZApp.confirm({title,body,ok,cancel,icon}) → Promise<boolean>  (in-app dialog; optional)
     MZApp.alerts()            → [{key, when: Date, title, body, channelId?, actionTypeId?, extra?}]  (optional)
   and gets back window.MZNative = { rescheduleAll, deviceStatus, openNotificationSettings, openBatterySettings }.

   ⚠️ Plugins come from window.Capacitor.Plugins (plain objects, no bundler). If you ever add a bundler and import
   plugins: NEVER await/return a plugin object itself (it's a Proxy that answers `then` → the promise hangs forever,
   visible only in `adb logcat`). Await the *method call* only.
============================================================ */
(function () {
  const Cap = window.Capacitor;
  const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  const P = (n) => (Cap && Cap.Plugins ? Cap.Plugins[n] : null);
  const A = () => window.MZApp || {};
  const isAr = () => (document.documentElement.lang || "ar").startsWith("ar");
  const T = (ar, en) => (isAr() ? ar : en);

  /* ---------- confirm: in-app dialog if the app has one (WebView confirm() is grey + English OK/CANCEL) ---------- */
  const ask = (o) => (A().confirm ? A().confirm(o) : Promise.resolve(confirm(o.title + (o.body ? "\n" + o.body : ""))));

  /* ---------- 1) local notifications ---------- */
  const LN = () => P("LocalNotifications");
  const CHANNEL = "reminders";
  const MAX_NOTIFS = 400;   // Android 12+ allows ~500 pending alarms per app — keep a margin

  // Stable id per alert (hash of its key). schedule() DISMISSES a visible notification with the same id, and fired
  // notifications stay in getPending() — sequential ids 1..N wiped reminders that were still on screen.
  function stableId(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
    return 1000 + (Math.abs(h) % 800000000);
  }
  let channelReady = false;
  async function ensureChannel() {
    if (channelReady || !LN()) return;
    try {
      await LN().createChannel({ id: CHANNEL, name: T("التنبيهات", "Reminders"), importance: 5, visibility: 1, vibration: true });
      channelReady = true;
    } catch (e) {}
  }
  async function ensurePermission() {
    if (!LN()) return false;
    const st = await LN().checkPermissions();
    if (st.display === "granted") return true;
    // "denied" is also reported after the dialog was merely dismissed → ask (at most once per launch)
    if (ensurePermission.asked) return false;
    ensurePermission.asked = true;
    return (await LN().requestPermissions()).display === "granted";
  }
  // Exact alarms (Android 12+): the state is in checkExactNotificationSetting, NOT checkPermissions
  async function exactAlarmsOk() {
    try { return (await LN().checkExactNotificationSetting()).exact_alarm === "granted"; } catch (e) { return true; }
  }
  async function askExactAlarms() {
    try { return (await LN().changeExactNotificationSetting()).exact_alarm === "granted"; } catch (e) { return false; }
  }

  /* Re-plan everything; re-send only new/changed alerts (comparing at/title/body/extra), cancel only stale ones. */
  let lastSig = null, timer = null;
  async function rescheduleAll(opts) {
    if (!isNative || !LN() || !A().alerts) return;
    const sig = inputSig();
    if (opts && opts.ifChanged && sig === lastSig) return;      // resume with nothing changed → nothing to do
    if (!(await ensurePermission())) return;
    await ensureChannel();
    try {
      const now = Date.now();
      const list = (A().alerts() || []).filter((n) => n.when && n.when.getTime() > now).sort((a, b) => a.when - b.when)
        .slice(0, MAX_NOTIFS).map((n) => {
          const o = { id: stableId(n.key), title: n.title, body: n.body || "", channelId: n.channelId || CHANNEL,
                      schedule: { at: n.when, allowWhileIdle: true }, smallIcon: "ic_stat_icon" };
          if (n.actionTypeId) o.actionTypeId = n.actionTypeId;
          if (n.extra) o.extra = n.extra;
          return o;
        });
      const wanted = new Set(list.map((n) => n.id));
      const pending = (await LN().getPending()).notifications || [];
      const stale = pending.filter((n) => !wanted.has(n.id));
      if (stale.length) await LN().cancel({ notifications: stale.map((n) => ({ id: n.id })) });
      const byId = new Map(pending.map((n) => [n.id, n]));
      const changed = list.filter((n) => {
        const p = byId.get(n.id);
        const at = p && p.schedule && p.schedule.at ? new Date(p.schedule.at).getTime() : NaN;
        return !(p && at === n.schedule.at.getTime() && p.title === n.title && p.body === n.body
                 && JSON.stringify(p.extra || {}) === JSON.stringify(n.extra || {}));
      });
      if (changed.length) await LN().schedule({ notifications: changed });
      lastSig = sig;
      console.info("[native] alerts:", list.length, "wanted ·", changed.length, "sent ·", stale.length, "cancelled");
    } catch (e) { console.warn("[native] schedule failed", e); }
  }
  // what the schedule depends on — list your localStorage keys here
  const SIG_KEYS = ["htmlshelf:data", "htmlshelf:settings"];
  function inputSig() {
    const s = new Date().toDateString() + "|" + SIG_KEYS.map((k) => localStorage.getItem(k) || "").join("|");
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h + ":" + s.length;
  }
  function queueReschedule(ms) { clearTimeout(timer); timer = setTimeout(rescheduleAll, ms || 3000); }

  /* ---------- 2) back button, system bars, splash ---------- */
  function polishUI() {
    const SB = P("SystemBars");   // core in Capacitor 8 (no @capacitor/status-bar)
    if (SB) {
      SB.setStyle({ style: "DARK", bar: "StatusBar" }).catch(() => {});   // light icons over a dark header
      const sync = () => SB.setStyle({ style: document.documentElement.getAttribute("data-theme") === "dark" ? "DARK" : "LIGHT", bar: "NavigationBar" }).catch(() => {});
      new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      sync();
    }
    P("SplashScreen")?.hide().catch(() => {});

    // Back: close what's open first; on the home page ask before leaving (an accidental Back must not exit).
    // Registering the listener disables Android's default, so every case must be handled here.
    P("App")?.addListener("backButton", () => {
      if (A().back && A().back()) return;
      ask({ icon: "🚪", title: T("تقفل التطبيق؟", "Close the app?"), ok: T("اقفل", "Close"), cancel: T("لأ", "Stay") })
        .then((ok) => { if (ok) P("App")?.exitApp(); });
    });
    // back in the app: re-plan only if something changed
    P("App")?.addListener("appStateChange", ({ isActive }) => { if (isActive) { clearTimeout(timer); timer = setTimeout(() => rescheduleAll({ ifChanged: true }), 1500); } });
  }

  /* ---------- 3) device status for a settings page ---------- */
  async function deviceStatus() {
    const S = P("AppSettings");
    if (!isNative || !S) return null;
    const t = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), 3000))]);   // never hang a page on a native call
    try {
      const st = await t(S.getStatus());
      const pend = LN() ? await t(LN().getPending()) : null;
      return st && { ...st, exactAlarms: st.exactAlarms, pending: pend ? (pend.notifications || []).length : undefined };
    } catch (e) { return null; }
  }
  const openNotificationSettings = () => P("AppSettings")?.openNotificationSettings().catch(() => {});
  const openBatterySettings = () => P("AppSettings")?.openBatterySettings().catch(() => {});

  /* ---------- init ---------- */
  function init() {
    if (!isNative) return;
    document.documentElement.classList.add("is-native");
    polishUI();
    timer = setTimeout(rescheduleAll, 800);   // after first paint
    // re-plan whenever the app saves data (debounced)
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function (k, v) { orig(k, v); if (SIG_KEYS.includes(k)) queueReschedule(); };
  }
  window.MZNative = { init, rescheduleAll, deviceStatus, openNotificationSettings, openBatterySettings, ensurePermission, exactAlarmsOk, askExactAlarms };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
