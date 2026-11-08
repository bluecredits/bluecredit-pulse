// Pulse · chief — the AI chief of staff. Reads what the signed-in person can see (chief_context runs AS them,
// so row-level security keeps it inside their workspace and permissions), asks Claude for a prioritized brief
// or an answer, and returns suggestions (action items, reminders, email drafts, meetings) that the person
// accepts with a click. It never changes anything by itself.
//
// POST {mode:"brief", tz, refresh?}            → today's brief (cached per person per day unless refresh)
// POST {mode:"ask", question, history[], tz}   → an answer about their workspace
// Secrets: ANTHROPIC_API_KEY; optional CHIEF_MODEL (default claude-sonnet-5-5), CHIEF_DAILY_LIMIT (per workspace, default 200).
import { caller, CORS, Deps, HttpError, json, need, needPlan, rest } from "../_shared/pulse.ts";

const TOOLS = [
  { name: "propose_action_item", description: "Suggest a follow-up action item to add to the team's action list. Only for staff (not contractors).",
    input_schema: { type: "object", properties: {
      text: { type: "string", description: "Short imperative task, e.g. 'Send capability statement to Jane at EPA'" },
      owner: { type: "string", description: "First name of a team member" }, due_date: { type: "string", description: "YYYY-MM-DD" },
      why: { type: "string", description: "One sentence on why this matters now" } }, required: ["text", "why"] } },
  { name: "propose_reminder", description: "Suggest a personal reminder for the person you're helping.",
    input_schema: { type: "object", properties: { text: { type: "string" }, remind_at: { type: "string", description: "ISO date-time in the person's time zone, e.g. 2026-11-10T09:00" },
      why: { type: "string" } }, required: ["text", "remind_at"] } },
  { name: "draft_email", description: "Draft a short email the person could send (they review and send it themselves).",
    input_schema: { type: "object", properties: { to: { type: "string", description: "Recipient name or email if known" }, subject: { type: "string" }, body: { type: "string" },
      why: { type: "string" } }, required: ["subject", "body"] } },
  { name: "propose_meeting", description: "Suggest a meeting for the Scheduler to find a time for.",
    input_schema: { type: "object", properties: { title: { type: "string" }, with: { type: "array", items: { type: "string" }, description: "First names of teammates" },
      minutes: { type: "integer" }, by_date: { type: "string", description: "YYYY-MM-DD, the latest it should happen" }, why: { type: "string" } }, required: ["title", "with", "minutes"] } },
];

function systemPrompt(name: string, ctx: any) {
  return `You are ${name}, the AI chief of staff for ${ctx.me?.name || "a team member"} at ${ctx.workspace || "their company"}, inside the Pulse workspace.
Act like an excellent human chief of staff: decide what matters most today, protect their time, keep commitments from slipping, and prepare them.

Rules:
- Use ONLY the workspace data provided. Never invent people, deadlines, numbers or facts. If something isn't in the data, say you don't see it.
- Today is ${ctx.weekday}, ${ctx.today} (${ctx.timezone}). Use relative dates ("tomorrow", "in 3 days") with the date.
- Be brief and concrete. Lead with the 3 most important things and why. Name the specific items (titles, people, request numbers).
- Flag risks: overdue actions, deadlines this week with no submission, approvals waiting on them, a timesheet not submitted, an overdue review cadence, follow-ups slipping.
- Suggest at most 5 next steps using the tools (action items, reminders, email drafts, meetings). The person decides whether to accept each one; never say you did something.
- ${ctx.me?.role === "contractor" ? "This person is a contractor: only discuss their own timesheet, onboarding checklist, requests and meetings." : "Respect privacy: tickets and timesheets are personal; only mention ones this person is involved in."}
- Format with short markdown: a one-line summary, then "## Top priorities" (numbered), then "## Also on your radar" (bullets), then, if useful, "## Today's calendar".`;
}

async function claude(d: Deps, system: string, messages: unknown[], tools = TOOLS) {
  const r = await d.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": d.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: d.env.CHIEF_MODEL || "claude-sonnet-5-5", max_tokens: 1800, system, tools, messages }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status === 429 ? 429 : 502, r.status === 429 ? "The assistant is busy right now. Try again in a minute." : `The assistant couldn't answer (${j.error?.message || r.status}).`);
  const text = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n\n").trim();
  const proposals = (j.content || []).filter((c: any) => c.type === "tool_use").map((c: any) => ({ type: c.name, ...c.input })).slice(0, 6);
  return { text, proposals, usage: j.usage || null };
}

async function countCall(me: any, d: Deps) {
  const limit = +(d.env.CHIEF_DAILY_LIMIT || 200), day = new Date(d.now ? d.now() : Date.now()).toISOString().slice(0, 10);
  const [u] = await rest(d, `chief_usage?workspace_id=eq.${me.workspace_id}&day=eq.${day}&select=calls`);
  if (u && u.calls >= limit) throw new HttpError(429, `Your workspace has used today's ${limit} assistant requests. It resets tomorrow.`);
  await rest(d, "chief_usage?on_conflict=workspace_id,day", { method: "POST", prefer: "resolution=merge-duplicates",
    body: JSON.stringify({ workspace_id: me.workspace_id, day, calls: (u?.calls || 0) + 1 }) });
}

export async function handle(req: Request, d: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST.");
    const me = await caller(req, d);
    await needPlan(d, me.workspace_id, "chief");
    need(d.env, "ANTHROPIC_API_KEY");
    const b = await req.json().catch(() => ({}));
    const tz = /^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(b.tz || "") ? b.tz : "UTC";
    const [ws] = await rest(d, `workspaces?id=eq.${me.workspace_id}&select=name,config`);
    const name = String(ws?.config?.chief_name || "Chief of Staff").slice(0, 40);
    // the person's own view of the workspace (row-level security applies)
    const ctx = await rest(d, "rpc/chief_context", { method: "POST", asUser: me.token, body: JSON.stringify({ p_tz: tz }) });
    const data = `<workspace_data>\n${JSON.stringify(ctx)}\n</workspace_data>`;
    if (b.mode === "brief") {
      if (!b.refresh) {
        const [c] = await rest(d, `chief_briefs?user_id=eq.${me.id}&brief_date=eq.${ctx.today}&select=content,created_at`);
        if (c) return json({ ...c.content, cached: true, created_at: c.created_at, name });
      }
      await countCall(me, d);
      const out = await claude(d, systemPrompt(name, ctx), [{ role: "user", content: `${data}\n\nWrite my brief for today.` }]);
      await rest(d, "chief_briefs?on_conflict=user_id,brief_date", { method: "POST", prefer: "resolution=merge-duplicates",
        body: JSON.stringify({ user_id: me.id, workspace_id: me.workspace_id, brief_date: ctx.today, content: { text: out.text, proposals: out.proposals } }) });
      return json({ text: out.text, proposals: out.proposals, cached: false, name });
    }
    if (b.mode === "ask") {
      const q = String(b.question || "").trim().slice(0, 2000);
      if (!q) throw new HttpError(400, "Ask a question.");
      const hist = (Array.isArray(b.history) ? b.history : []).slice(-8)
        .filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .map((m: any) => ({ role: m.role, content: m.content.slice(0, 4000) }));
      // conversation must start with the person and alternate turns
      const msgs: any[] = [{ role: "user", content: `${data}\n\nUse this data for everything I ask in this conversation.` }, { role: "assistant", content: "Understood. What would you like to know?" }];
      for (const m of hist) if (msgs[msgs.length - 1].role !== m.role) msgs.push(m);
      if (msgs[msgs.length - 1].role === "user") msgs.pop();
      msgs.push({ role: "user", content: q });
      await countCall(me, d);
      const out = await claude(d, systemPrompt(name, ctx).replace(/- Format with short markdown:[^\n]*/, "- Answer the question directly in short markdown."), msgs);
      return json({ text: out.text, proposals: out.proposals, name });
    }
    throw new HttpError(400, "Unknown mode.");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
}

// Supabase Edge Functions ignore the port; on our own server (deploy/) PORT and HOST come from the service file.
if (import.meta.main) Deno.serve({ port: +(Deno.env.get("PORT") || 8000), hostname: Deno.env.get("HOST") || "0.0.0.0" }, (req) => handle(req, { fetch, env: Deno.env.toObject() }));
