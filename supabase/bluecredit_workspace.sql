-- One-time, for BlueCredit's own workspace after upgrading to the multi-company schema.
-- Run AFTER supabase/schema.sql. Names the first workspace BlueCredit and keeps the lists, review agendas
-- and owner names the team used before the upgrade (the general starter pack would otherwise replace them).
-- Safe to re-run. Contains list names only, no business data.
update public.workspaces set name = 'BlueCredit', template = 'govcon', config = $cfg${
 "lists": {
  "opportunities.kind": [
   "Federal Contract",
   "Consulting",
   "Subcontract",
   "Forecast",
   "Water Credit Project",
   "State/Local",
   "International",
   "Other"
  ],
  "funding.type": [
   "Grant",
   "Accelerator",
   "Pitch Competition",
   "Fellowship",
   "VC",
   "Seed Round",
   "Loan",
   "Award",
   "Incubator",
   "SBIR/STTR",
   "Resources",
   "Other"
  ],
  "contacts.category": [
   "Government",
   "Corporate",
   "Corporate Prospect",
   "Investor",
   "Prime Contractor",
   "Partner",
   "NGO",
   "Utility",
   "Expert",
   "Academic",
   "Mailing List",
   "Other"
  ],
  "resources.category": [
   "Bid Board",
   "Forecast Portal",
   "Events",
   "Registration",
   "Below-SAT Strategy",
   "District Office",
   "Feasibility Program",
   "Training",
   "Other"
  ]
 },
 "agendas": {
  "daily": [
   "Yesterday: what moved (submissions, replies, calls)",
   "Today: top 3 priorities per person",
   "Deadlines in the next 7 days",
   "Blockers / asks"
  ],
  "weekly": [
   "Last week's action items \u2014 close out",
   "Submissions and decisions this week",
   "Deadlines in the next 30 days \u2014 go / no-go",
   "Outreach and follow-ups due",
   "New opportunities to qualify"
  ],
  "monthly": [
   "Pipeline by stage and value",
   "Wins, losses, lessons learned",
   "Funding: submitted, pending decisions, upcoming",
   "Partner / subcontractor relationships",
   "Professional development (FE/PE, CFM, PMP, GSA MAS)",
   "Next month's targets"
  ],
  "quarterly": [
   "Quarter results vs goals (submissions, win rate, $ won, $ raised)",
   "Performance by owner",
   "Strategy: agencies, NAICS, markets \u2014 keep / add / drop",
   "Fundraise and investor pipeline",
   "Goals for next quarter"
  ]
 },
 "owners": [
  "Barasa",
  "Sohaib",
  "Robert",
  "Beckee"
 ],
 "working_exclude": [
  "Mailing List",
  "Corporate Prospect",
  "Expert"
 ],
 "links": []
}$cfg$::jsonb
 where id = (select id from public.workspaces order by created_at limit 1);
select name, join_code, template from public.workspaces order by created_at limit 1;
