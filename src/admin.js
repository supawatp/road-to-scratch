// /api/v1/admin/* - admin portal: users, approvals, programs, chat history, photos, export and delete.
import { json, error, readJson } from "./api.js";
import { listUsers, getUser, updateUser, getProfile, saveProfile, isAdmin } from "./users.js";
import { listMessages } from "./msglog.js";
import { listMedia, deleteUserMedia } from "./media.js";
import {
  listPrograms, getProgram, latestProgram, activateProgram, nextMonday, validateDesign, programToDesign, setProgramStatus,
} from "./programs.js";
import { enqueueJob, pendingJob } from "./jobqueue.js";
import { guardedPush, dashboardUrl } from "./context.js";
import { fmtDay } from "./dates.js";

const one = async (db, sql, ...a) => db.prepare(sql).bind(...a).first();

async function userSummary(db, u) {
  const [lastCheckin, msgs, photos, prog, profile] = await Promise.all([
    one(db, "SELECT MAX(date) d FROM daily WHERE user_id = ?", u.id),
    one(db, "SELECT COUNT(*) n, MAX(ts) last FROM messages WHERE user_id = ?", u.id),
    one(db, "SELECT COUNT(*) n FROM media WHERE user_id = ?", u.id),
    one(db, "SELECT id, version, status FROM programs WHERE user_id = ? ORDER BY version DESC LIMIT 1", u.id),
    getProfile(db, u.id),
  ]);
  return { ...u, lastCheckin: lastCheckin && lastCheckin.d, messages: msgs ? msgs.n : 0, lastMessage: msgs && msgs.last,
    photos: photos ? photos.n : 0, program: prog || null, flags: profile.flags, answered: !!profile.answeredAt };
}

const TABLES_WITH_USER = ["daily", "rounds", "tests", "body", "coach", "shots", "messages", "media", "programs", "profiles", "jobs", "convo"];

export async function handleAdmin(request, base, url, parts, waitUntil = p => p) {
  const db = base.env.DB;
  const method = request.method;
  const nowIso = base.now().toISOString();
  try {
    if (parts[0] === "users" && parts.length === 1 && method === "GET") {
      const users = await listUsers(db);
      return json({ items: await Promise.all(users.map(u => userSummary(db, u))) });
    }
    if (parts[0] === "jobs" && method === "GET") {
      const { results } = await db.prepare("SELECT id, kind, user_id, status, error, attempts, created, updated FROM jobs ORDER BY created DESC LIMIT 50").all();
      return json({ items: results });
    }
    if (parts[0] === "programs" && parts[1]) {
      const p = await getProgram(db, parts[1]);
      if (!p) return error(404, "not found");
      if (method === "GET") return json(p);
      if (method === "PUT") {
        const b = await readJson(request);
        if (!b.program || typeof b.program !== "object") return error(400, "program is required", "invalid_argument");
        let errs;
        try { errs = validateDesign(programToDesign(b.program)); } catch (e) { errs = [e.message]; }
        if (errs.length) return json({ error: "program is not valid", errors: errs }, 400);
        await db.prepare("UPDATE programs SET json = ?, summary = COALESCE(?, summary), updated = ? WHERE id = ?")
          .bind(JSON.stringify(b.program), b.summary ?? null, nowIso, p.id).run();
        return json(await getProgram(db, p.id));
      }
    }

    if (parts[0] !== "users" || !parts[1]) return error(404, "not found");
    const user = await getUser(db, parts[1]);
    if (!user) return error(404, "user not found");
    const ctx = base.forUser(user);
    const sub = parts[2];

    if (!sub && method === "GET") {
      const [summary, profile, programs] = await Promise.all([userSummary(db, user), getProfile(db, user.id), listPrograms(db, user.id)]);
      return json({ user: summary, profile, programs });
    }
    if (!sub && method === "PUT") {
      const b = await readJson(request);
      const fields = {};
      for (const k of ["name", "lang", "golfer", "limits"]) if (k in b) fields[k] = b[k];
      if ("status" in b) {
        if (isAdmin(user)) return error(400, "the admin's status can't be changed", "invalid_argument");
        if (!["disabled", "pending", "onboarding", "active", "new"].includes(b.status)) return error(400, "invalid status", "invalid_argument");
        fields.status = b.status;
      }
      return json({ user: await updateUser(db, user.id, fields, nowIso) });
    }
    if (sub === "approve" && method === "POST") {
      if (!["new", "pending"].includes(user.status)) return error(400, `user is ${user.status}`, "invalid_argument");
      const u = await updateUser(db, user.id, { status: "onboarding", approvedAt: nowIso }, nowIso);
      const uctx = base.forUser(u);
      const link = base.env.LIFF_ID ? `https://liff.line.me/${base.env.LIFF_ID}/onboarding` : null;
      const th = u.lang === "th";
      const text = th ? `ได้รับการอนุมัติแล้ว! เริ่มจากแบบสอบถาม 5 นาที${link ? `\n${link}` : ""}` : `You're approved! Start with the 5-minute questionnaire${link ? `:\n${link}` : "."}`;
      waitUntil(guardedPush(uctx, [text]).catch(e => console.error("approve push", e)));
      return json({ user: u });
    }
    if (sub === "activate" && method === "POST") {
      const b = await readJson(request).catch(() => ({}));
      const p = b.programId ? await getProgram(db, b.programId) : await latestProgram(db, user.id);
      if (!p || p.userId !== user.id) return error(400, "no program to activate", "invalid_argument");
      const today = base.today();
      const start = b.start && /^\d{4}-\d{2}-\d{2}$/.test(b.start) ? b.start : nextMonday(today);
      await activateProgram(db, p.id, start, today, nowIso);
      const u = isAdmin(user) ? user : await updateUser(db, user.id, { status: "active" }, nowIso);
      const uctx = base.forUser(u);
      const th = u.lang === "th";
      const msg = th ? `แผนของคุณพร้อมแล้ว! เริ่มวัน${fmtDay(start)} ทุกเช้า 08:45 จะส่งแผนประจำวัน และ 21:30 เช็กอิน\nแดชบอร์ด: ${await dashboardUrl(uctx)}`
        : `Your program is ready! It starts ${fmtDay(start)}. Every morning at 08:45 you'll get the day's plan, and at 21:30 a quick check-in.\nDashboard: ${await dashboardUrl(uctx)}`;
      waitUntil(guardedPush(uctx, [msg]).catch(e => console.error("activate push", e)));
      return json({ ok: true, start, user: u });
    }
    if (sub === "reject-program" && method === "POST") {
      const latest = await latestProgram(db, user.id);
      if (latest) await setProgramStatus(db, latest.id, "rejected", nowIso);
      return json({ ok: true });
    }
    if (sub === "design" && method === "POST") {
      const b = await readJson(request).catch(() => ({}));
      if (await pendingJob(db, user.id, "design")) return error(409, "a design job is already running", "already_exists");
      const latest = await latestProgram(db, user.id);
      const id = await enqueueJob(db, "design", user.id, { brief: b.brief || "", changes: b.changes || "", previousId: b.changes && latest ? latest.id : null }, nowIso);
      return json({ job: id });
    }
    if (sub === "profile" && method === "PUT") {
      const b = await readJson(request);
      const patch = {};
      if ("notes" in b) patch.notes = String(b.notes || "").slice(0, 4000);
      if (Array.isArray(b.flags)) patch.flags = b.flags.map(String).slice(0, 30);
      return json(await saveProfile(db, user.id, patch, nowIso));
    }
    if (sub === "messages" && method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "100", 10) || 100;
      return json({ items: await listMessages(db, user.id, { before: url.searchParams.get("before"), limit }) });
    }
    if (sub === "media" && method === "GET") return json({ items: await listMedia(db, user.id) });
    if (sub === "export" && method === "GET") {
      const out = { exported: nowIso, user, profile: await getProfile(db, user.id) };
      for (const t of TABLES_WITH_USER) {
        if (t === "profiles") continue;
        out[t] = (await db.prepare(`SELECT * FROM ${t} WHERE user_id = ?`).bind(user.id).all()).results;
      }
      const { results } = await db.prepare("SELECT * FROM settings WHERE key LIKE ?").bind(`u:${user.id}:%`).all();
      out.settings = results;
      return new Response(JSON.stringify(out, null, 1), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="road-to-scratch-${user.id}.json"` } });
    }
    if (!sub && method === "DELETE") {
      if (isAdmin(user)) return error(400, "the admin account can't be deleted here", "invalid_argument");
      if (url.searchParams.get("confirm") !== user.id) return error(400, "add ?confirm=<user id> to delete", "invalid_argument");
      const files = await deleteUserMedia(base.env, user.id);
      await db.batch([
        ...TABLES_WITH_USER.map(t => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id)),
        db.prepare("DELETE FROM settings WHERE key LIKE ?").bind(`u:${user.id}:%`),
        db.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
      ]);
      return json({ deleted: user.id, files });
    }
    void ctx;
    return error(404, "not found");
  } catch (e) {
    if (e instanceof SyntaxError || /body|invalid/.test(e.message)) return error(400, e.message, "invalid_argument");
    throw e;
  }
}
