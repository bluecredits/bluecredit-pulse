/* Pulse — starter packs. A new workspace picks one at sign-up; it sets the drop-down lists and review agendas.
   Admins change any of it later in Workspace settings (saved per workspace, so packs here only set the starting point).
   Pipeline stages and statuses are the same everywhere, because reports and reviews count on them. */
window.PULSE_PACKS = {
  general: {
    label: "Startup basics",
    blurb: "Sales pipeline, customers, investors, partners and grants.",
    lists: {
      "opportunities.kind": ["New customer", "Expansion", "Pilot", "Partnership", "Contract", "Grant-funded project", "Other"],
      "funding.type": ["Grant", "Accelerator", "Pitch Competition", "Angel", "VC", "Seed Round", "Loan", "SBIR/STTR", "Award", "Other"],
      "contacts.category": ["Customer", "Prospect", "Investor", "Partner", "Advisor", "Vendor", "Government", "Media", "Mailing List", "Other"],
      "resources.category": ["Tools", "Templates", "Programs", "Events", "Training", "Other"],
    },
    working_exclude: ["Mailing List"],
    agendas: {
      daily: ["New SAM.gov, grant and bid matches: add to the pipeline or dismiss", "Yesterday: what moved", "Today: top 3 priorities per person", "Deadlines in the next 7 days", "Blockers and asks"],
      weekly: ["Last week's action items: close out", "Deals and applications that moved", "Deadlines in the next 30 days", "Follow-ups due", "New opportunities to qualify"],
      monthly: ["Pipeline by stage and value", "Wins, losses and lessons", "Funding: submitted, pending, upcoming", "Key relationships", "Next month's targets"],
      quarterly: ["Results vs goals (revenue, win rate, money raised)", "Performance by owner", "Strategy: markets and customers to keep, add or drop", "Fundraise and investor pipeline", "Goals for next quarter"],
    },
  },
  govcon: {
    label: "Government contracting",
    blurb: "Solicitations, forecasts, primes and teaming partners, agency contacts.",
    lists: {
      "opportunities.kind": ["Federal Contract", "Subcontract", "Forecast", "Task Order", "State/Local", "Grant-funded project", "Commercial", "Other"],
      "funding.type": ["Grant", "SBIR/STTR", "Accelerator", "Loan", "Award", "Pitch Competition", "VC", "Other"],
      "contacts.category": ["Government", "Small Business Office", "Prime Contractor", "Teaming Partner", "Corporate", "Investor", "Expert", "Academic", "Mailing List", "Other"],
      "resources.category": ["Bid Board", "Forecast Portal", "Registration", "Small Business Office", "Events", "Training", "Other"],
    },
    working_exclude: ["Mailing List"],
    agendas: {
      daily: ["New SAM.gov, grant and bid matches: add to the pipeline or dismiss", "Yesterday: submissions, replies, calls", "Today: top 3 priorities per person", "Deadlines in the next 7 days", "Blockers and asks"],
      weekly: ["Last week's action items: close out", "Submissions and decisions this week", "Deadlines in the next 30 days: go / no-go", "Outreach to agencies and primes", "New solicitations and forecasts to qualify"],
      monthly: ["Pipeline by stage and value", "Wins, losses and debriefs", "Teaming and subcontractor relationships", "Registrations and certifications (SAM, set-asides)", "Next month's targets"],
      quarterly: ["Quarter results vs goals (submissions, win rate, $ won)", "Performance by owner", "Strategy: agencies, NAICS and vehicles to keep, add or drop", "Past performance and capability statement", "Goals for next quarter"],
    },
  },
  fundraising: {
    label: "Fundraising",
    blurb: "Investor pipeline, rounds, accelerators, grants and early customers.",
    lists: {
      "opportunities.kind": ["Customer", "Pilot", "Partnership", "Strategic", "Other"],
      "funding.type": ["Pre-seed", "Seed Round", "Series A", "SAFE / Convertible", "Angel", "VC", "Corporate VC", "Grant", "Accelerator", "Loan", "Other"],
      "contacts.category": ["Angel", "VC", "Corporate VC", "Family Office", "Accelerator", "Advisor", "Customer", "Partner", "Media", "Mailing List", "Other"],
      "resources.category": ["Investor lists", "Data room", "Templates", "Programs", "Events", "Other"],
    },
    working_exclude: ["Mailing List"],
    agendas: {
      daily: ["Investor meetings yesterday and today", "Follow-ups owed", "Deadlines in the next 7 days", "Blockers and asks"],
      weekly: ["Last week's action items: close out", "Investor pipeline: who moved", "Applications and deadlines in the next 30 days", "Intros to ask for", "Customer traction update"],
      monthly: ["Round progress: committed vs target", "Investor update email", "Grants and programs: submitted, pending", "Key metrics", "Next month's targets"],
      quarterly: ["Raise results vs plan", "Runway and burn", "Strategy: investor fit, terms, timing", "Board and advisor updates", "Goals for next quarter"],
    },
  },
};

// The workspace's lists: its saved settings over its starter pack over the general pack.
function workspaceSettings(ws) {
  const P = window.PULSE_PACKS, base = P.general, pack = P[ws?.template] || base, cfg = ws?.config || {};
  return {
    lists: { ...base.lists, ...pack.lists, ...(cfg.lists || {}) },
    agendas: { ...base.agendas, ...pack.agendas, ...(cfg.agendas || {}) },
    working_exclude: cfg.working_exclude || pack.working_exclude || base.working_exclude,
    owners: cfg.owners || [],
  };
}
