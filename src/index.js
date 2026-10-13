// Cloudflare Worker entry point.
import program from "../source/program.json";
import { DASHBOARD_HTML } from "./generated/dashboard.js"; // written by `npm run build`
import { createApp } from "./app.js";

const app = createApp({ program, dashboardHtml: DASHBOARD_HTML });

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (event, env, ctx) => app.scheduled(event, env, ctx),
};
