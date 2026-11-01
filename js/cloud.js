/* رفّ المشاريع — Google Drive backup of every project (Android app only).

   "Sign in with Google" = pick a Google account and allow the app (scope drive.file) to manage the files IT creates in
   that account's Drive — it can't see any other file. Everything goes into one visible folder, FOLDER, so the user can
   find it at drive.google.com. Per project there is:
     <title> — بيانات.json   that project's saved data (its own localStorage, see shimFor in index.html):
                              { app, pid, title, t, keys: { key: value } }
     <title>.html            projects the user added themself (built-ins ship with the app)
     <title> — نسخة <day>.html   old versions (the archive), appProperties.of = the project
     إعدادات الرفّ.json      shelf settings: lists, favourites, archive, names, icons, categories, sort/view
   Every file carries appProperties { app, kind: "data"|"html", pid, t } — t = when that copy last changed.

   Per project the newer copy wins (last change time): phone newer → upload, Drive newer → restore onto the phone.
   That makes reinstall / new phone work: sign in, and each project's data + the added projects come back.
   Removing an added project removes its Drive files too (queued while offline).
   Rules learned in GymPlan / Dawa El Beit: one sync at a time (promise chain), token requests name the account,
   check the token's account is the signed-in account before writing.

   The page provides window.ShelfHost (see index.html) and gets window.ShelfCloud (bottom of this file). */
(function () {
  var C = window.Capacitor;
  var native = !!(C && C.isNativePlatform && C.isNativePlatform());
  /* Web version (GitHub Pages): Google Identity Services token client, OAuth "Web" client of the same Google Cloud
     project as the Android app — drive.file access belongs to the project, so both see the same backup files.
     A browser can't renew a token silently: it lasts an hour, after that «احفظ دلوقتي» asks again (one click). */
  var WEB_CLIENT_ID = window.SHELF_WEB_CLIENT_ID || "";
  var gisP = null;
  function loadGis() {
    if (!gisP) gisP = new Promise(function (res, rej) {
      var s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true;
      s.onload = res; s.onerror = function () { gisP = null; rej(new Error("network: gsi")); }; document.head.appendChild(s);
    });
    return gisP;
  }
  var webAuth = !native && WEB_CLIENT_ID ? {
    getAccessToken: async function (o) {
      if (!o.interactive) throw new Error("needs-consent");
      await loadGis();
      return new Promise(function (res, rej) {
        var tc = window.google.accounts.oauth2.initTokenClient({
          client_id: WEB_CLIENT_ID, scope: o.scopes.join(" "), hint: o.email || undefined, prompt: o.email ? "" : "select_account",
          callback: function (r) { if (r && r.access_token) res({ accessToken: r.access_token, expiresIn: +r.expires_in || 3500 }); else rej(new Error("needs-consent")); },
          error_callback: function () { rej(new Error("needs-consent")); }
        });
        tc.requestAccessToken();
      });
    }
  } : null;
  var AUTH = native && C.Plugins ? C.Plugins.GoogleDriveAuth : webAuth; // plugin: plain object — never await the plugin itself

  var SCOPE = "https://www.googleapis.com/auth/drive.file";
  var API = "https://www.googleapis.com/drive/v3", UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  var FOLDER = "رفّ المشاريع — نسخ احتياطية";
  var APP = "html-shelf";
  var KEY = "shelf:cloud";

  var ls = window.localStorage;
  function load() { try { return Object.assign({ account: null, token: null, folder: null, up: {}, pendingDel: [], lastSync: 0 }, JSON.parse(ls.getItem(KEY) || "{}")); } catch (e) { return { account: null, token: null, folder: null, up: {}, pendingDel: [], lastSync: 0 }; } }
  var st = load();
  function save() { try { ls.setItem(KEY, JSON.stringify(st)); } catch (e) {} }
  var H = function () { return window.ShelfHost; };

  var listeners = [], state = "idle", error = "";
  function setState(s, e) { state = s; error = e || ""; listeners.forEach(function (fn) { try { fn(api.info()); } catch (x) {} }); }

  // ── tokens + Drive requests ──
  async function token(interactive) {
    var email = st.account ? st.account.email : "";
    if (email && st.token && st.token.email === email && st.token.exp - 120000 > Date.now()) return st.token.token;
    if (!AUTH) throw new Error("not-available");
    var res = await AUTH.getAccessToken({ scopes: [SCOPE], interactive: !!interactive, email: email });
    if (!res || !res.accessToken) throw new Error("needs-consent");
    st.token = { email: email, token: res.accessToken, exp: Date.now() + (res.expiresIn || 3500) * 1000 }; save();
    return res.accessToken;
  }
  async function drive(url, opt) {
    opt = opt || {};
    var go = async function () {
      var t = await token(false);
      return fetch(url, { method: opt.method || "GET", headers: Object.assign({ Authorization: "Bearer " + t }, opt.headers || {}), body: opt.body });
    };
    var res = await go();
    if (res.status === 401) { st.token = null; save(); res = await go(); }
    if (!res.ok && res.status !== 404) {
      var text = ""; try { text = await res.text(); } catch (e) {}
      var err = new Error("drive-" + res.status + ": " + text.slice(0, 160)); err.status = res.status; throw err;
    }
    if (opt.as === "text") return res.text();
    if (opt.as === "none" || res.status === 204 || res.status === 404) return null;
    return res.json();
  }
  var q = function (s) { return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'"; };

  async function folderId() {
    if (st.folder && st.folder.email === st.account.email) {
      var f = await drive(API + "/files/" + st.folder.id + "?fields=id,trashed");
      if (f && !f.trashed) return st.folder.id;
    }
    var r = await drive(API + "/files?pageSize=10&fields=files(id)&q=" + encodeURIComponent(
      "name=" + q(FOLDER) + " and mimeType='application/vnd.google-apps.folder' and trashed=false"));
    var id = r.files && r.files[0] ? r.files[0].id : null;
    if (!id) {
      var c = await drive(API + "/files?fields=id", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: FOLDER, mimeType: "application/vnd.google-apps.folder", appProperties: { app: APP } }) });
      id = c.id;
    }
    st.folder = { email: st.account.email, id: id }; save();
    return id;
  }
  async function listFolder(fid) {
    var out = [], page = "";
    do {
      var r = await drive(API + "/files?pageSize=1000&fields=nextPageToken,files(id,name,appProperties)" + (page ? "&pageToken=" + page : "") +
        "&q=" + encodeURIComponent(q(fid) + " in parents and trashed=false"));
      out = out.concat(r.files || []); page = r.nextPageToken || "";
    } while (page);
    return out.filter(function (f) { return f.appProperties && f.appProperties.app === APP && f.appProperties.pid; });
  }
  async function upload(fileId, meta, content, mime) {
    var b = "shelf" + Math.random().toString(36).slice(2);
    var body = "--" + b + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) +
      "\r\n--" + b + "\r\nContent-Type: " + mime + "; charset=UTF-8\r\n\r\n" + content + "\r\n--" + b + "--";
    var url = UPLOAD + "/files" + (fileId ? "/" + fileId : "") + "?uploadType=multipart&fields=id";
    var r = await drive(url, { method: fileId ? "PATCH" : "POST", headers: { "Content-Type": "multipart/related; boundary=" + b }, body: body });
    return r.id;
  }
  var safeName = function (s) { return String(s || "مشروع").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 90); };

  // ── one full pass ──
  async function syncOnce() {
    var host = H();
    if (!st.account || !host) return;
    setState("syncing");
    // the token must belong to the signed-in account (another account on the phone could answer otherwise)
    var who = await drive(API + "/about?fields=user(emailAddress)");
    if (!who || !who.user || who.user.emailAddress !== st.account.email) throw new Error("account-mismatch");
    var fid = await folderId();
    var files = await listFolder(fid);
    var by = {};
    files.forEach(function (f) { var a = f.appProperties; by[a.kind + ":" + a.pid] = f; });

    // removed added-projects → remove their Drive files
    for (var i = 0; i < st.pendingDel.length; i++) {
      var pid = st.pendingDel[i];
      for (var kind of ["data", "html"]) {
        var f = by[kind + ":" + pid];
        if (f) { await drive(API + "/files/" + f.id, { method: "DELETE", as: "none" }); delete by[kind + ":" + pid]; }
      }
      delete st.up["data:" + pid]; delete st.up["html:" + pid];
      for (var vk in by) { // its old versions too
        if (by[vk].appProperties.kind === "version" && by[vk].appProperties.of === pid) {
          await drive(API + "/files/" + by[vk].id, { method: "DELETE", as: "none" }); delete st.up[vk]; delete by[vk];
        }
      }
    }
    st.pendingDel = []; save();

    // project HTML: projects the user added (u:…) + newer versions of built-in projects (b:… — an update or a restored
    // old version replaces the copy shipped in the app). One here that is gone in Drive after we had it there was
    // reset to the original on another device; one in Drive we never had comes down.
    var userFiles = await host.userFiles();
    var local = {};
    userFiles.forEach(function (u) { local[u.id] = u; });
    for (var u of userFiles) {
      var t = u.updatedAt || u.added || 0, rf = by["html:" + u.id], rt = rf ? +rf.appProperties.t || 0 : -1;
      if (rt > t) {
        var html = await drive(API + "/files/" + rf.id + "?alt=media", { as: "text" });
        if (html != null) await host.addUserFile({ id: u.id, title: u.title, html: html, size: html.length, added: u.added || rt, updatedAt: rt });
        st.up["html:" + u.id] = 1;
      } else if (!rf && st.up["html:" + u.id] && u.id.indexOf("b:") === 0) {
        await host.dropFile(u.id); // built-in reset to its original on another device
        delete st.up["html:" + u.id];
      } else if (!rf || t > rt) {
        await upload(rf && rf.id, rf ? { name: safeName(u.title) + ".html", appProperties: { app: APP, kind: "html", pid: u.id, t: String(t) } }
          : { name: safeName(u.title) + ".html", parents: [fid], appProperties: { app: APP, kind: "html", pid: u.id, t: String(t) } }, u.html, "text/html");
        st.up["html:" + u.id] = 1;
      }
    }
    for (var k in by) {
      var f2 = by[k], a = f2.appProperties;
      if (a.kind !== "html" || local[a.pid] || host.wasRemoved(a.pid)) continue;
      if (a.pid.indexOf("b:") === 0) {
        if (st.up[k]) { await drive(API + "/files/" + f2.id, { method: "DELETE", as: "none" }); delete st.up[k]; continue; } // reset here
        if (!host.hasProject(a.pid)) continue;
      }
      var html2 = await drive(API + "/files/" + f2.id + "?alt=media", { as: "text" }); // a project added on another phone / before a reinstall
      if (html2 != null) { await host.addUserFile({ id: a.pid, title: f2.name.replace(/\.html?$/i, ""), html: html2, size: html2.length, added: +a.t || Date.now() }); st.up[k] = 1; }
    }

    // shelf settings (lists, favourites, archive, names, icons, categories, sort/view) — one file, newer wins
    var mineS = host.settings(), rs = by["settings:_shelf"], rst = rs ? +rs.appProperties.t || 0 : -1;
    if (rs && rst > mineS.t) {
      var sdoc = await drive(API + "/files/" + rs.id + "?alt=media");
      if (sdoc && sdoc.data) await host.applySettings(sdoc.data, rst);
    } else if (mineS.t && (!rs || mineS.t > rst)) {
      var sm = { name: "إعدادات الرفّ.json", appProperties: { app: APP, kind: "settings", pid: "_shelf", t: String(mineS.t) } };
      if (!rs) sm.parents = [fid];
      await upload(rs && rs.id, sm, JSON.stringify({ app: APP, t: mineS.t, data: mineS.data }), "application/json");
    }

    // old versions: each is uploaded once; one deleted on this phone (uploaded before, gone now) is deleted in Drive,
    // one in Drive that this phone never had (another phone, a reinstall) comes down
    var vers = await host.versionList(), haveV = {};
    for (var v of vers) {
      haveV[v.id] = 1;
      if (by["version:" + v.id]) { st.up["version:" + v.id] = 1; continue; }
      var day = new Date(v.added).toISOString().slice(0, 10);
      await upload(null, { name: safeName(v.title) + " — نسخة " + day + ".html", parents: [fid],
        appProperties: { app: APP, kind: "version", pid: v.id, of: v.pid, t: String(v.added) } }, v.html, "text/html");
      st.up["version:" + v.id] = 1;
    }
    for (var key in by) {
      var fv = by[key], av = fv.appProperties;
      if (av.kind !== "version" || haveV[av.pid]) continue;
      if (st.up[key]) { await drive(API + "/files/" + fv.id, { method: "DELETE", as: "none" }); delete st.up[key]; continue; }
      if (!host.hasProject(av.of)) continue;
      var vh = await drive(API + "/files/" + fv.id + "?alt=media", { as: "text" });
      if (vh != null) { await host.addVersion({ id: av.pid, pid: av.of, title: fv.name.replace(/ — نسخة .*$/, ""), html: vh, size: vh.length, added: +av.t || Date.now() }); st.up[key] = 1; }
    }
    save();

    // every project's saved data
    var pids = {};
    host.dataPids().forEach(function (p) { pids[p] = 1; });
    Object.keys(by).forEach(function (k) { if (by[k].appProperties.kind === "data") pids[by[k].appProperties.pid] = 1; });
    for (var p in pids) {
      var mine = host.localData(p), rf2 = by["data:" + p], rt2 = rf2 ? +rf2.appProperties.t || 0 : -1;
      var lt = mine.t || 0, has = Object.keys(mine.keys).length > 0;
      if (rf2 && rt2 > lt) {
        var doc = await drive(API + "/files/" + rf2.id + "?alt=media");
        if (doc && doc.keys) { host.applyData(p, doc.keys, rt2); st.up["data:" + p] = rt2; }
      } else if ((has || rf2) && (!rf2 || lt > rt2)) { // rf2 && !has: the project cleared all its data → Drive too
        if (!lt) { lt = Date.now(); host.stampData(p, lt); } // data from before backups existed
        var title = host.title(p), body = JSON.stringify({ app: APP, pid: p, title: title, t: lt, keys: mine.keys });
        var m = { name: safeName(title) + " — بيانات.json", appProperties: { app: APP, kind: "data", pid: p, t: String(lt) } };
        if (!rf2) m.parents = [fid];
        await upload(rf2 && rf2.id, m, body, "application/json");
        st.up["data:" + p] = lt;
      }
    }
    st.lastSync = Date.now(); save();
    setState("ok");
  }

  var chain = Promise.resolve(), timer = null;
  function sync() {
    chain = chain.then(syncOnce).catch(function (e) {
      var m = String(e && e.message || e);
      setState("error", m);
      if (/needs-consent|account-mismatch/.test(m)) { st.token = null; save(); }
    });
    return chain;
  }
  function soon(ms) { if (!st.account) return; clearTimeout(timer); timer = setTimeout(sync, ms || 4000); }

  var api = {
    available: !!AUTH,
    info: function () { return { signedIn: !!st.account, email: st.account ? st.account.email : "", name: st.account ? st.account.name : "", state: state, error: error, lastSync: st.lastSync }; },
    onChange: function (fn) { listeners.push(fn); },
    signIn: async function () {
      setState("signing-in");
      try {
        st.account = null; st.token = null;
        var res = await AUTH.getAccessToken({ scopes: [SCOPE], interactive: true, email: "" });
        var r = await fetch(API + "/about?fields=user(displayName,emailAddress)", { headers: { Authorization: "Bearer " + res.accessToken } });
        if (!r.ok) throw new Error("drive-" + r.status + ": " + (await r.text()).slice(0, 160)); // 403 = Drive API not enabled
        var who = await r.json();
        if (!who.user || !who.user.emailAddress) throw new Error("no-account");
        st.account = { email: who.user.emailAddress, name: who.user.displayName || "" };
        st.token = { email: st.account.email, token: res.accessToken, exp: Date.now() + (res.expiresIn || 3500) * 1000 };
        st.up = {}; save();
        await sync();
        return true;
      } catch (e) { setState("error", String(e && e.message || e)); return false; }
    },
    // permission expired (web: after an hour; Android: rarely) → ask again for the same account, then sync
    reauth: async function () {
      try { st.token = null; save(); await token(true); return sync(); }
      catch (e) { setState("error", String(e && e.message || e)); }
    },
    web: !native,
    signOut: function () { st = load(); st.account = null; st.token = null; st.folder = null; st.up = {}; save(); setState("idle"); },
    sync: sync,
    changed: function () { soon(4000); },            // a project saved something
    removed: function (pid) { if (st.pendingDel.indexOf(pid) < 0) st.pendingDel.push(pid); save(); soon(1500); },
    _state: function () { return st; }
  };
  window.ShelfCloud = api;

  if (native && C.Plugins.App) C.Plugins.App.addListener("appStateChange", function (s) { if (!s.isActive) soon(10); else soon(1500); });
  else document.addEventListener("visibilitychange", function () { soon(document.hidden ? 10 : 1500); });
  window.addEventListener("online", function () { soon(1000); });
  setInterval(function () { soon(10); }, 5 * 60 * 1000);
  if (st.account) setTimeout(function () { soon(10); }, 2000);
})();
