// /admin - admin portal (admin cookie only). Talks to /api/v1/admin/*.

export function adminPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Road to Scratch Admin</title>
<style>
:root{--bg:#fff;--surface:#f6f7f4;--raise:#fff;--ink:#17201b;--ink2:#4a544e;--muted:#737d77;--line:#e4e7e2;--chip:#eef1ec;--accent:#1f4d3a;--accent-ink:#fff;--gold:#9a7e45;--good:#2e7d4f;--warn:#9a5f0c;--bad:#b3402f}
@media (prefers-color-scheme:dark){:root{--bg:#0e1210;--surface:#151a17;--raise:#1a201c;--ink:#ecefec;--ink2:#c2c9c4;--muted:#8f9892;--line:#2a322d;--chip:#1f2622;--accent:#8cc7a6;--accent-ink:#0e1210;--gold:#cdb27a;--good:#5fbf86;--warn:#e0a04a;--bad:#e07a68}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,"Segoe UI",Roboto,"Noto Sans Thai",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:20px 16px 60px}h1{font:400 30px Georgia,serif;margin:0}h2{font:400 22px Georgia,serif;margin:0 0 10px}h3{font-size:15px;margin:18px 0 8px}
.eyebrow{font:11px ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--gold)}.muted{color:var(--muted)}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.between{justify-content:space-between}
.card{background:var(--raise);border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:16px;min-width:0}
.tablewrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{font:500 11px ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);background:var(--surface)}
tr.sel td{background:var(--surface)}tr[data-id]{cursor:pointer}
.pill{display:inline-block;font-size:12px;padding:2px 9px;border-radius:999px;background:var(--chip);color:var(--ink2)}
.pill.active{color:var(--good)}.pill.pending,.pill.onboarding{color:var(--warn)}.pill.disabled,.pill.left{color:var(--bad)}
.btn{appearance:none;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);font-weight:600;font-size:13px;font-family:inherit;padding:7px 14px;border-radius:999px;cursor:pointer}
.btn.ghost{background:transparent;color:var(--accent)}.btn.danger{border-color:var(--bad);color:var(--bad);background:transparent}.btn:disabled{opacity:.45}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0;font-size:14px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
textarea,input[type=text]{width:100%;font-size:14px;font-family:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
textarea{min-height:110px}pre{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;max-height:420px;font-size:12px}
.chat{display:grid;gap:6px;max-height:520px;overflow:auto;padding:4px}.msg{max-width:80%;padding:7px 11px;border-radius:12px;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.msg.in{background:var(--surface);justify-self:start}.msg.out{background:var(--chip);justify-self:end}.msg small{display:block;color:var(--muted);font-size:11px;margin-top:2px}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}.photos figure{margin:0;font-size:12px}.photos img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;border:1px solid var(--line)}
.status{font-size:13px;color:var(--muted)}.flag{color:var(--warn);font-weight:600}
</style></head><body><div class="wrap">
<div class="row between"><div><div class="eyebrow">Road to Scratch</div><h1>Admin</h1></div><div class="row"><a class="btn ghost" href="/">My dashboard</a><a class="btn ghost" href="/logout">Log out</a></div></div>
<div class="card"><div class="row between"><h2>Users</h2><span class="status" id="st"></span></div><div class="tablewrap"><table id="users"><thead><tr>
<th>Name</th><th>Status</th><th>Golf</th><th>Flags</th><th>Last check-in</th><th>Messages</th><th>Photos</th><th>Program</th></tr></thead><tbody></tbody></table></div></div>
<div id="detail"></div>
<div class="card"><h2>Background jobs</h2><div class="tablewrap"><table id="jobs"><thead><tr><th>Created</th><th>Kind</th><th>User</th><th>Status</th><th>Tries</th><th>Error</th></tr></thead><tbody></tbody></table></div></div>
</div>
<script>
"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const when = s => s ? new Date(s).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
let USERS = [], SEL = null;
async function api(path, opts = {}) {
  const r = await fetch("/api/v1/admin" + path, { credentials: "same-origin", ...opts, headers: opts.body ? { "Content-Type": "application/json" } : {} });
  if (r.status === 401) { location.href = "/login"; throw new Error("login"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error || r.status) + (j.errors ? ": " + j.errors.join("; ") : ""));
  return j;
}
const post = (p, b) => api(p, { method: "POST", body: JSON.stringify(b || {}) });
const put = (p, b) => api(p, { method: "PUT", body: JSON.stringify(b || {}) });
function say(t) { $("#st").textContent = t; }

async function loadUsers() {
  USERS = (await api("/users")).items;
  $("#users tbody").innerHTML = USERS.map(u => '<tr data-id="' + esc(u.id) + '"' + (u.id === SEL ? ' class="sel"' : "") + '><td>' + esc(u.name || u.displayName || u.id.slice(0, 10)) + (u.role === "admin" ? ' <span class="pill">admin</span>' : "") +
    '</td><td><span class="pill ' + esc(u.status) + '">' + esc(u.status) + '</span></td><td>' + (u.golfer ? "yes" : u.golfer === false ? "no" : "") +
    '</td><td class="flag">' + esc((u.flags || []).join(", ")) + '</td><td>' + esc(u.lastCheckin || "") + '</td><td>' + u.messages + '</td><td>' + u.photos +
    '</td><td>' + (u.program ? "v" + u.program.version + " " + esc(u.program.status) : "") + '</td></tr>').join("");
  document.querySelectorAll("#users tr[data-id]").forEach(tr => tr.onclick = () => { SEL = tr.dataset.id; loadUsers(); showUser(SEL); });
  const jobs = (await api("/jobs")).items;
  $("#jobs tbody").innerHTML = jobs.map(j => '<tr><td>' + when(j.created) + '</td><td>' + esc(j.kind) + '</td><td>' + esc((USERS.find(u => u.id === j.user_id) || {}).name || j.user_id) + '</td><td>' + esc(j.status) + '</td><td>' + j.attempts + '</td><td style="white-space:normal">' + esc(j.error || "") + '</td></tr>').join("") || '<tr><td colspan="6" class="muted">None</td></tr>';
}

async function showUser(id) {
  const d = await api("/users/" + encodeURIComponent(id));
  const u = d.user, p = d.profile;
  const latest = d.programs[0];
  const acts = [];
  if (["new", "pending"].includes(u.status)) acts.push('<button class="btn" data-act="approve">Approve</button>');
  if (latest && ["accepted", "proposed"].includes(latest.status)) acts.push('<button class="btn" data-act="activate">Activate v' + latest.version + '</button>');
  if (u.role !== "admin") acts.push(u.status === "disabled" ? '<button class="btn ghost" data-act="enable">Enable</button>' : '<button class="btn ghost" data-act="disable">Disable</button>');
  acts.push('<a class="btn ghost" href="/api/v1/admin/users/' + encodeURIComponent(u.id) + '/export">Export data</a>');
  if (u.role !== "admin") acts.push('<button class="btn danger" data-act="delete">Delete user</button>');
  const answers = Object.entries(p.answers || {}).map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(Array.isArray(v) ? v.join(", ") : v) + '</dd>').join("");
  $("#detail").innerHTML = '<div class="card"><div class="row between"><div><h2>' + esc(u.name || u.displayName || u.id) + '</h2><div class="muted" style="font-size:13px">' + esc(u.id) + ' · joined ' + when(u.created) + ' · last seen ' + when(u.lastSeen) + '</div></div><div class="row">' + acts.join("") + '</div></div>' +
    '<div class="grid" style="margin-top:12px"><div><h3>Questionnaire</h3>' + (answers ? '<dl>' + answers + '</dl>' : '<p class="muted">Not answered yet.</p>') +
    '<h3>Health flags</h3><p class="flag">' + esc((p.flags || []).join(", ") || "none") + '</p></div>' +
    '<div><h3>Coach notes</h3><textarea id="notes">' + esc(p.notes || "") + '</textarea><div class="row" style="margin-top:8px"><button class="btn ghost" id="saveNotes">Save notes</button><span class="status" id="notesSt"></span></div>' +
    '<h3>Limits</h3><label class="muted" style="font-size:13px">Coach questions per day <input type="text" id="chatDaily" style="width:80px" value="' + esc(u.limits && u.limits.chatDaily != null ? u.limits.chatDaily : "") + '" placeholder="30"></label> <button class="btn ghost" id="saveLimits">Save</button></div></div>' +
    '<h3>Programs</h3><div class="tablewrap"><table><thead><tr><th>Version</th><th>Status</th><th>Created</th><th>Summary</th><th></th></tr></thead><tbody>' +
    (d.programs.map(x => '<tr><td>v' + x.version + '</td><td>' + esc(x.status) + '</td><td>' + when(x.created) + '</td><td style="white-space:normal;max-width:480px">' + esc((x.summary || "").slice(0, 220)) + '</td><td><button class="btn ghost" data-view="' + esc(x.id) + '">View</button></td></tr>').join("") || '<tr><td colspan="5" class="muted">None yet</td></tr>') +
    '</tbody></table></div><div class="row" style="margin-top:8px"><input type="text" id="brief" placeholder="Brief or requested changes for a new draft (optional)"><button class="btn ghost" id="design">' + (latest ? "Request revision" : "Design program") + '</button><span class="status" id="designSt"></span></div><div id="progView"></div>' +
    '<div class="grid"><div><h3>Chat</h3><div class="chat" id="chat"></div><button class="btn ghost" id="more" style="margin-top:8px">Older messages</button></div><div><h3>Photos & files</h3><div class="photos" id="photos"></div></div></div></div>';
  document.querySelectorAll("[data-act]").forEach(b => b.onclick = () => act(u, b.dataset.act));
  $("#saveNotes").onclick = async () => { await put("/users/" + encodeURIComponent(u.id) + "/profile", { notes: $("#notes").value }); $("#notesSt").textContent = "Saved"; };
  $("#saveLimits").onclick = async () => { const v = $("#chatDaily").value.trim(); await put("/users/" + encodeURIComponent(u.id), { limits: { ...(u.limits || {}), chatDaily: v === "" ? undefined : Number(v) } }); say("Limits saved"); };
  $("#design").onclick = async () => { try { await post("/users/" + encodeURIComponent(u.id) + "/design", latest ? { changes: $("#brief").value } : { brief: $("#brief").value }); $("#designSt").textContent = "Queued: the draft goes to the user in LINE in a few minutes."; loadUsers(); } catch (e) { $("#designSt").textContent = e.message; } };
  document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => viewProgram(b.dataset.view));
  let before = null;
  const loadChat = async () => {
    const items = (await api("/users/" + encodeURIComponent(u.id) + "/messages?limit=60" + (before ? "&before=" + encodeURIComponent(before) : ""))).items;
    if (items.length) before = items[items.length - 1].ts;
    const html = items.reverse().map(m => '<div class="msg ' + m.dir + '">' + (m.media_id ? '<a href="/media/' + esc(m.media_id) + '" target="_blank">[' + esc(m.type) + ']</a> ' : "") + esc(m.text || (m.type !== "text" ? "[" + m.type + "]" : "")) + '<small>' + when(m.ts) + (m.model ? " · " + esc(m.model) + " " + (m.tokens_in || 0) + "/" + (m.tokens_out || 0) + " tok" : "") + '</small></div>').join("");
    $("#chat").insertAdjacentHTML("afterbegin", html);
    if (!items.length) $("#more").disabled = true;
  };
  $("#more").onclick = loadChat;
  await loadChat(); $("#chat").scrollTop = $("#chat").scrollHeight;
  const media = (await api("/users/" + encodeURIComponent(u.id) + "/media")).items;
  $("#photos").innerHTML = media.map(m => '<figure><a href="/media/' + esc(m.id) + '" target="_blank">' + (m.type === "image" ? '<img loading="lazy" src="/media/' + esc(m.id) + '" alt="' + esc(m.description || "photo") + '">' : '[' + esc(m.type) + ']') + '</a><figcaption>' + when(m.ts) + (m.category ? ' · <b>' + esc(m.category) + '</b>' : "") + '<br>' + esc(m.description || "") + '</figcaption></figure>').join("") || '<p class="muted">None yet</p>';
}

async function viewProgram(id) {
  const p = await api("/programs/" + encodeURIComponent(id));
  $("#progView").innerHTML = '<h3>Program v' + p.version + ' (' + esc(p.status) + ')</h3><p style="white-space:pre-wrap">' + esc(p.summary || "") + '</p>' + (p.changes ? '<p class="muted">Changes: ' + esc(p.changes) + '</p>' : "") +
    '<textarea id="progJson" style="min-height:320px;font:12px ui-monospace,Menlo,monospace">' + esc(JSON.stringify(p.program, null, 2)) + '</textarea><div class="row" style="margin-top:8px"><button class="btn ghost" id="saveProg">Save edits</button><span class="status" id="progSt"></span></div>';
  $("#saveProg").onclick = async () => {
    try { await put("/programs/" + encodeURIComponent(id), { program: JSON.parse($("#progJson").value) }); $("#progSt").textContent = "Saved"; }
    catch (e) { $("#progSt").textContent = e.message; }
  };
}

async function act(u, a) {
  const path = "/users/" + encodeURIComponent(u.id);
  try {
    if (a === "approve") { await post(path + "/approve"); say("Approved: questionnaire link sent in LINE"); }
    if (a === "activate") { const r = await post(path + "/activate"); say("Activated, starts " + r.start); }
    if (a === "disable") { await put(path, { status: "disabled" }); say("Disabled"); }
    if (a === "enable") { await put(path, { status: "active" }); say("Enabled"); }
    if (a === "delete") {
      const typed = prompt("This deletes ALL of this user's data, chats and photos. Type the user id to confirm:\\n" + u.id);
      if (typed !== u.id) return say("Delete cancelled");
      await api(path + "?confirm=" + encodeURIComponent(u.id), { method: "DELETE" }); SEL = null; $("#detail").innerHTML = ""; say("Deleted");
    }
  } catch (e) { say(e.message); }
  await loadUsers(); if (SEL) showUser(SEL);
}
loadUsers().catch(e => say(e.message));
</script></body></html>`;
}
