// /api/v1/me/* - the signed-in LINE user's own account: sign-up, questionnaire, status.
import { json, error, readJson } from "./api.js";
import { updateUser, getProfile, saveProfile, getUser } from "./users.js";
import { SECTIONS, QUESTIONNAIRE_VERSION, cleanAnswers, healthFlags } from "./questionnaire.js";
import { latestProgram } from "./programs.js";
import { askCoach } from "./chat.js";
import { guardedPush } from "./context.js";
import { notifyAdmins } from "./jobs.js";

const publicUser = u => ({ id: u.id, name: u.name, displayName: u.displayName, picture: u.picture, status: u.status, golfer: u.golfer, lang: u.lang, admin: u.role === "admin" });

export async function handleMe(request, ctx, url, parts, waitUntil = p => p) {
  const method = request.method;
  const nowIso = ctx.now().toISOString();
  const user = ctx.user;
  try {
    if (!parts.length && method === "GET") {
      const [profile, latest] = await Promise.all([getProfile(ctx.db, user.id), latestProgram(ctx.db, user.id)]);
      return json({ user: publicUser(user), profile: { answers: profile.answers, answeredAt: profile.answeredAt },
        program: latest ? { id: latest.id, version: latest.version, status: latest.status, summary: latest.summary } : null,
        questionnaire: { version: QUESTIONNAIRE_VERSION, sections: SECTIONS } });
    }

    if (parts[0] === "signup" && method === "POST") {
      const b = await readJson(request);
      if (b.consent !== true) return error(400, "consent is required", "invalid_argument");
      const name = String(b.name || "").trim().slice(0, 60);
      if (!name) return error(400, "name is required", "invalid_argument");
      const lang = b.lang === "th" ? "th" : "en";
      if (!["new", "pending"].includes(user.status)) return json({ user: publicUser(user), already: true });
      const u = await updateUser(ctx.db, user.id, { name, lang, status: "pending", consentAt: nowIso }, nowIso);
      waitUntil(notifyAdmins(ctx, `New sign-up: ${name} (${user.displayName || user.id}). Approve in the admin portal.`).catch(e => console.error(e)));
      return json({ user: publicUser(u) });
    }

    if (parts[0] === "questionnaire" && method === "POST") {
      if (!["onboarding", "active"].includes(user.status)) return error(403, "your account is not approved yet", "permission_denied");
      const b = await readJson(request);
      const { answers, errors } = cleanAnswers(b.answers);
      if (errors.length) return json({ error: "please check your answers", errors }, 400);
      const flags = healthFlags(answers);
      const first = !(await getProfile(ctx.db, user.id)).answeredAt;
      await saveProfile(ctx.db, user.id, { answers, answersVersion: QUESTIONNAIRE_VERSION, answeredAt: nowIso, flags }, nowIso);
      const u = await updateUser(ctx.db, user.id, { name: answers.name || user.name, lang: answers.lang || user.lang, golfer: !!answers.plays_golf }, nowIso);
      if (user.status === "onboarding" && ctx.env.ANTHROPIC_API_KEY) {
        // Start the follow-up interview in LINE.
        const uctx = ctx.forUser(await getUser(ctx.db, user.id));
        waitUntil((async () => {
          const res = await askCoach(uctx, first ? "[I just finished the questionnaire.]" : "[I updated my questionnaire answers.]", { onboarding: true });
          await guardedPush(uctx, [res.text], { model: res.usage && res.usage.model, tokensIn: res.usage && res.usage.tokensIn, tokensOut: res.usage && res.usage.tokensOut });
        })().catch(e => console.error("onboarding interview", e)));
      }
      if (flags.length) waitUntil(notifyAdmins(ctx, `${u.name} finished the questionnaire. Health flags: ${flags.join(", ")}`).catch(() => {}));
      return json({ ok: true, flags, user: publicUser(u) });
    }
    return error(404, "not found");
  } catch (e) {
    if (e instanceof SyntaxError || /body/.test(e.message)) return error(400, e.message, "invalid_argument");
    throw e;
  }
}
