// LIFF pages opened inside LINE: /liff/signup, /liff/onboarding, /liff/app (personal dashboard).
// LINE login (LIFF ID token) is exchanged for a session cookie at POST /auth/liff.

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function liffPage(env) {
  const liffId = esc(env.LIFF_ID || "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">
<title>Road to Scratch</title>
<style>
:root{--bg:#fff;--surface:#f6f7f4;--ink:#17201b;--ink2:#4a544e;--muted:#737d77;--line:#e4e7e2;--accent:#1f4d3a;--accent-ink:#fff;--gold:#9a7e45;--bad:#b3402f}
@media (prefers-color-scheme:dark){:root{--bg:#0e1210;--surface:#151a17;--ink:#ecefec;--ink2:#c2c9c4;--muted:#8f9892;--line:#2a322d;--accent:#8cc7a6;--accent-ink:#0e1210;--gold:#cdb27a;--bad:#e07a68}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,"Segoe UI",Roboto,"Noto Sans Thai",sans-serif}
main{max-width:560px;margin:0 auto;padding:20px 16px 96px}
h1{font:400 28px Georgia,serif;margin:0 0 4px}h2{font:400 21px Georgia,serif;margin:0 0 8px}
.eyebrow{font:11px ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--gold)}
.muted{color:var(--muted)}.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0}
label.q{display:block;margin:16px 0 6px;font-weight:600;font-size:15px}
input[type=text],input[type=number],input[type=time],select,textarea{width:100%;font-size:16px;font-family:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:11px 12px}
.opts{display:flex;flex-wrap:wrap;gap:8px}.opts label{position:relative}.opts input{position:absolute;opacity:0;inset:0;margin:0}
.opts span{display:inline-block;padding:9px 14px;border:1px solid var(--line);border-radius:999px;font-size:15px;background:var(--bg)}
.opts input:checked+span{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.opts input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:12px 16px calc(12px + env(safe-area-inset-bottom));display:flex;gap:10px;justify-content:center}
.bar>*{max-width:270px;flex:1}
button{appearance:none;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);font-weight:600;font-size:16px;font-family:inherit;padding:12px 18px;border-radius:999px}
button.ghost{background:transparent;color:var(--accent)}button:disabled{opacity:.45}
.err{color:var(--bad);font-size:14px;margin-top:8px}.progress{height:4px;background:var(--line);border-radius:4px;overflow:hidden;margin:10px 0 2px}
.progress i{display:block;height:100%;background:var(--accent)}.consent{font-size:14px;color:var(--ink2)}.consent li{margin:4px 0}
.check{display:flex;gap:10px;align-items:flex-start;margin-top:14px}.check input{width:22px;height:22px;margin-top:2px}
</style></head><body><main id="app"><p class="muted">Loading…</p></main>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<script>
"use strict";
const LIFF_ID = "${liffId}";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let ME = null, LANG = (navigator.language || "").startsWith("th") ? "th" : "en";
const T = (en, th) => LANG === "th" ? th : en;
const pick = arr => Array.isArray(arr) ? (LANG === "th" ? arr[1] : arr[0]) : arr;
const app = $("#app");

async function api(path, body) {
  const r = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || ("HTTP " + r.status)); e.details = j.errors; throw e; }
  return j;
}
function fail(msg) { app.innerHTML = '<div class="eyebrow">Road to Scratch</div><h1>' + T("Something went wrong", "เกิดข้อผิดพลาด") + '</h1><p class="err">' + esc(msg) + '</p>'; }
function closeBtn() { return '<div class="bar"><button onclick="liff.closeWindow()">' + T("Close", "ปิด") + '</button></div>'; }

async function start() {
  if (!LIFF_ID) return fail("LIFF_ID is not configured on the server.");
  await liff.init({ liffId: LIFF_ID });
  if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
  const idToken = liff.getIDToken();
  await api("/auth/liff", { idToken });
  ME = await api("/api/v1/me");
  if (ME.user.lang) LANG = ME.user.lang;
  const route = location.pathname.replace(/^\\/liff\\/?/, "").split("/")[0];
  if (route === "app") { location.replace("/"); return; }
  if (route === "signup" || ME.user.status === "new") return signup();
  if (route === "onboarding" || ME.user.status === "onboarding") return ME.user.status === "onboarding" || ME.user.status === "active" ? questionnaire() : status();
  return status();
}

function status() {
  const s = ME.user.status;
  const msg = { pending: T("Thanks for signing up! Your coach will approve your account soon.", "ขอบคุณที่สมัคร! โค้ชจะอนุมัติบัญชีเร็ว ๆ นี้"),
    onboarding: T("You're approved. Fill in the questionnaire to get your program.", "อนุมัติแล้ว กรอกแบบสอบถามเพื่อรับแผน"),
    active: T("Your program is active.", "แผนของคุณเริ่มแล้ว") }[s] || s;
  app.innerHTML = '<div class="eyebrow">Road to Scratch</div><h1>' + esc(ME.user.name || ME.user.displayName || "") + '</h1><p>' + esc(msg) + '</p>' +
    (s === "active" ? '<div class="bar"><button onclick="location.replace(\\'/\\')">' + T("Open dashboard", "เปิดแดชบอร์ด") + '</button></div>' : closeBtn());
}

function signup() {
  if (ME.user.status !== "new") return status();
  app.innerHTML = '<div class="eyebrow">Road to Scratch</div><h1>' + T("Sign up", "สมัครใช้งาน") + '</h1>' +
    '<p class="muted">' + T("A personal health (and golf) coach in LINE: a daily plan, a quick evening check-in and a coach you can ask anything.", "โค้ชสุขภาพ (และกอล์ฟ) ส่วนตัวใน LINE: แผนประจำวัน เช็กอินตอนเย็น และโค้ชที่ถามได้ทุกเรื่อง") + '</p>' +
    '<label class="q" for="name">' + T("Your name", "ชื่อของคุณ") + '</label><input type="text" id="name" maxlength="60" value="' + esc(ME.user.name || ME.user.displayName || "") + '">' +
    '<label class="q" for="lang">' + T("Language", "ภาษา") + '</label><select id="lang"><option value="th"' + (LANG === "th" ? " selected" : "") + '>ไทย</option><option value="en"' + (LANG === "en" ? " selected" : "") + '>English</option></select>' +
    '<div class="card consent"><b>' + T("Your data", "ข้อมูลของคุณ") + '</b><ul>' +
    '<li>' + T("We store what you share to coach you: your profile and health answers, check-ins, logs, chat messages, and photos or files you send.", "เราเก็บข้อมูลที่คุณให้เพื่อใช้โค้ช: โปรไฟล์และคำตอบด้านสุขภาพ การเช็กอิน บันทึก ข้อความแชท และรูปหรือไฟล์ที่คุณส่ง") + '</li>' +
    '<li>' + T("Data is stored on Cloudflare. Messages and photos you send to the coach are processed by Anthropic's Claude AI to answer you.", "ข้อมูลจัดเก็บบน Cloudflare ข้อความและรูปที่ส่งถึงโค้ชจะถูกประมวลผลโดย Claude AI ของ Anthropic เพื่อตอบคุณ") + '</li>' +
    '<li>' + T("Only you and your coach (the admin) can see your data. You can ask for a copy or for deletion at any time.", "มีเพียงคุณและโค้ช (ผู้ดูแล) ที่เห็นข้อมูลของคุณ ขอสำเนาหรือขอลบได้ตลอดเวลา") + '</li>' +
    '<li>' + T("This is coaching, not medical advice. Check with your doctor about health conditions and medication.", "นี่คือการโค้ช ไม่ใช่คำแนะนำทางการแพทย์ ปรึกษาแพทย์เรื่องโรคและยา") + '</li></ul>' +
    '<label class="check"><input type="checkbox" id="consent"><span>' + T("I agree to my data being stored and used as described above.", "ฉันยินยอมให้จัดเก็บและใช้ข้อมูลตามที่ระบุข้างต้น") + '</span></label></div>' +
    '<p class="err" id="err" hidden></p><div class="bar"><button id="go">' + T("Sign up", "สมัคร") + '</button></div>';
  $("#lang").onchange = e => { LANG = e.target.value; const n = $("#name").value; signup(); $("#name").value = n; };
  $("#go").onclick = async () => {
    const err = $("#err"); err.hidden = true;
    if (!$("#consent").checked) { err.textContent = T("Please tick the consent box.", "กรุณาติ๊กช่องยินยอม"); err.hidden = false; return; }
    $("#go").disabled = true;
    try {
      const r = await api("/api/v1/me/signup", { name: $("#name").value, lang: $("#lang").value, consent: true });
      ME.user = r.user;
      app.innerHTML = '<div class="eyebrow">Road to Scratch</div><h1>' + T("Thank you!", "ขอบคุณ!") + '</h1><p>' + T("Your coach will approve your account soon. You'll get a message in LINE.", "โค้ชจะอนุมัติบัญชีเร็ว ๆ นี้ คุณจะได้รับข้อความใน LINE") + '</p>' + closeBtn();
    } catch (e) { err.textContent = e.message; err.hidden = false; $("#go").disabled = false; }
  };
}

// ---- questionnaire ----
let STEP = 0, ANS = {};
const KEY = () => "rts-q-" + ME.user.id;
function saveDraft() { try { localStorage.setItem(KEY(), JSON.stringify({ STEP, ANS })); } catch (e) {} }
function questionnaire() {
  const prev = ME.profile && ME.profile.answers || {};
  ANS = Object.keys(prev).length ? { ...prev } : {};
  try { const d = JSON.parse(localStorage.getItem(KEY()) || "null"); if (d) { ANS = { ...ANS, ...d.ANS }; STEP = d.STEP || 0; } } catch (e) {}
  if (!ANS.name) ANS.name = ME.user.name || ME.user.displayName || "";
  if (!ANS.lang) ANS.lang = LANG;
  renderStep();
}
const visible = q => !q.showIf || ANS[q.showIf] === true;
function field(q) {
  const v = ANS[q.id], name = 'name="' + q.id + '"';
  if (q.type === "text") return '<input type="text" id="q_' + q.id + '" maxlength="500" value="' + esc(v ?? "") + '">';
  if (q.type === "number") return '<input type="number" inputmode="decimal" id="q_' + q.id + '" min="' + q.min + '" max="' + q.max + '" value="' + esc(v ?? "") + '">';
  if (q.type === "time") return '<input type="time" id="q_' + q.id + '" value="' + esc(v ?? "") + '">';
  if (q.type === "yesno") return '<div class="opts">' + [[true, T("Yes", "ใช่")], [false, T("No", "ไม่")]].map(([x, l]) => '<label><input type="radio" ' + name + ' value="' + x + '"' + (v === x ? " checked" : "") + '><span>' + l + '</span></label>').join("") + '</div>';
  if (q.type === "scale") return '<div class="opts">' + [1, 2, 3, 4, 5].map(x => '<label><input type="radio" ' + name + ' value="' + x + '"' + (Number(v) === x ? " checked" : "") + '><span>' + x + '</span></label>').join("") + '</div>';
  const multi = q.type === "multi";
  return '<div class="opts">' + q.options.map(o => '<label><input type="' + (multi ? "checkbox" : "radio") + '" ' + name + ' value="' + esc(o[0]) + '"' +
    ((multi ? (v || []).includes(o[0]) : v === o[0]) ? " checked" : "") + '><span>' + esc(LANG === "th" ? o[2] : o[1]) + '</span></label>').join("") + '</div>';
}
function readStep(sec) {
  for (const q of sec.questions) {
    if (!visible(q)) continue;
    if (["text", "number", "time"].includes(q.type)) { const el = $("#q_" + q.id); if (el) ANS[q.id] = el.value.trim() === "" ? undefined : (q.type === "number" ? Number(el.value) : el.value.trim()); }
    else if (q.type === "multi") ANS[q.id] = [...document.querySelectorAll('input[name="' + q.id + '"]:checked')].map(i => i.value);
    else { const el = document.querySelector('input[name="' + q.id + '"]:checked'); ANS[q.id] = el ? (q.type === "yesno" ? el.value === "true" : q.type === "scale" ? Number(el.value) : el.value) : undefined; }
  }
}
function missing(sec) {
  return sec.questions.filter(q => visible(q) && q.required && (ANS[q.id] === undefined || ANS[q.id] === "" || (Array.isArray(ANS[q.id]) && !ANS[q.id].length)));
}
function renderStep() {
  const S = ME.questionnaire.sections, sec = S[STEP];
  if (ANS.lang) LANG = ANS.lang;
  app.innerHTML = '<div class="eyebrow">' + T("Questionnaire", "แบบสอบถาม") + ' · ' + (STEP + 1) + '/' + S.length + '</div>' +
    '<div class="progress"><i style="width:' + Math.round((STEP + 1) / S.length * 100) + '%"></i></div><h2>' + esc(pick(sec.title)) + '</h2>' +
    (sec.note ? '<p class="muted" style="font-size:14px">' + esc(pick(sec.note)) + '</p>' : "") +
    sec.questions.filter(visible).map(q => '<label class="q" for="q_' + q.id + '">' + esc(pick(q.label)) + (q.required ? "" : ' <span class="muted" style="font-weight:400">' + T("(optional)", "(ไม่บังคับ)") + '</span>') + '</label>' + field(q)).join("") +
    '<p class="err" id="err" hidden></p><div class="bar">' + (STEP ? '<button class="ghost" id="back">' + T("Back", "ย้อนกลับ") + '</button>' : "") +
    '<button id="next">' + (STEP === S.length - 1 ? T("Submit", "ส่งคำตอบ") : T("Next", "ถัดไป")) + '</button></div>';
  window.scrollTo(0, 0);
  // golf follow-ups appear as soon as "Yes" is tapped
  document.querySelectorAll('input[name="plays_golf"]').forEach(i => i.onchange = () => { readStep(sec); renderStep(); });
  document.querySelectorAll('input[name="lang"]').forEach(i => i.onchange = () => { readStep(sec); renderStep(); });
  if ($("#back")) $("#back").onclick = () => { readStep(sec); STEP--; saveDraft(); renderStep(); };
  $("#next").onclick = async () => {
    readStep(sec); saveDraft();
    const m = missing(sec), err = $("#err");
    if (m.length) { err.textContent = T("Please answer: ", "กรุณาตอบ: ") + m.map(q => pick(q.label)).join(", "); err.hidden = false; return; }
    if (STEP < S.length - 1) { STEP++; saveDraft(); return renderStep(); }
    $("#next").disabled = true;
    try {
      await api("/api/v1/me/questionnaire", { answers: ANS });
      try { localStorage.removeItem(KEY()); } catch (e) {}
      app.innerHTML = '<div class="eyebrow">Road to Scratch</div><h1>' + T("Thanks!", "ขอบคุณ!") + '</h1><p>' + T("Your coach will message you in LINE with a few follow-up questions, then draft your program.", "โค้ชจะส่งข้อความใน LINE ถามเพิ่มเล็กน้อย แล้วร่างแผนให้คุณ") + '</p>' + closeBtn();
    } catch (e) { err.textContent = e.message + (e.details ? " (" + e.details.join("; ") + ")" : ""); err.hidden = false; $("#next").disabled = false; }
  };
}

start().catch(e => fail(e.message || String(e)));
</script></body></html>`;
}
