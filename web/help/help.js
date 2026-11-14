/* Pulse Help Center: one place for help on every app. Public page (no sign-in needed).
   Address: help/#<topic> or help/#<topic>/<section>, e.g. help/#opportunities/sam. The ? button in every app's top bar
   opens the topic for that app. Articles live in TOPICS below; search covers titles and text. */
"use strict";
const HUB = "../";
const $ = (s, el = document) => el.querySelector(s);
const ic = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
const step = (t, b) => `<li><strong class="st">${t}</strong><span>${b}</span></li>`;
const steps = (...a) => `<ol class="help-steps">${a.map((x) => step(x[0], x[1])).join("")}</ol>`;
const note = (title, items) => `<div class="help-note"><b>${title}</b><ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul></div>`;
const app = (path, label) => `<a href="${HUB}${path}">${label}</a>`;
const plan = (p) => `<span class="hc-plan ${p.toLowerCase()}">${p}</span>`;

const GROUPS = [["start", "Getting started"], ["win", "Find and win work"], ["deliver", "Deliver the work"], ["daily", "Every day"], ["admin", "Admin and billing"]];

const TOPICS = [
  // ── Getting started ──
  { id: "start", group: "start", icon: "home", title: "Welcome to Pulse", blurb: "What Pulse is, how to get in, and who sees what.",
    sections: [
      { id: "what", title: "What Pulse is", html: `<p>Pulse is an all-in-one workspace for small firms, a simple CRM plus everything after the deal: find and win work (Business Review, Contacts, Funding, Opportunities), deliver it (Projects, Agreements, People) and run the team day to day (Timecards, Tickets, Scheduler, Chief of Staff). One sign-in opens every app; the <b>All apps</b> grid at the top right of every page switches between them.</p>` },
      { id: "join", title: "Get in", html: steps(
          ["Start a workspace", `On the ${app("", "Pulse home page")} choose <b>Start a workspace</b>, enter your company name and your details. You become its admin. New workspaces get 14 days of Pro free.`],
          ["Or join your company", `Staff: ask your admin for the company code and choose <b>Join with code</b>. Employees, contractors and consultants: open the link in your welcome email, which takes you to the ${app("portal/", "employee portal")} with your code filled in.`],
          ["Confirm your email", `If Pulse sends a confirmation email, open the link in it, then sign in.`]) },
      { id: "roles", title: "Roles: who sees what", html: `<div class="table-wrap"><table class="help-table"><thead><tr><th>Role</th><th>How they join</th><th>What they see</th></tr></thead><tbody>
          <tr><td><b>Admin</b></td><td>Started the workspace, or promoted by an admin</td><td>Every app, plus team, codes, settings, plan and billing</td></tr>
          <tr><td><b>Member</b></td><td>Company code</td><td>Every app in your plan</td></tr>
          <tr><td><b>Employee</b></td><td>Employee code (the invite link)</td><td>The employee portal: their onboarding checklist, policies to certify, contracts to sign, devices, hours, requests and the projects they're on. Never contacts, pipeline, funding or bids.</td></tr>
          <tr><td><b>Contractor</b></td><td>Contractor code (the invite link)</td><td>The same as an employee, for people outside the payroll. Free.</td></tr></tbody></table></div>
        <p>Each company's data is private to that company: Pulse checks the workspace on every row in the database, not just in the screens.</p>` },
      { id: "portal", title: "The employee portal", html: `<p>Employees and contractors sign in at ${app("portal/", "the employee portal")}. It opens on what needs doing: contracts to sign, policies to certify, onboarding steps, devices to confirm and last week's timesheet. Quick actions ask for time off, equipment, IT help or an expense; <b>My requests</b> shows where each one stands.</p>
          <p>First time? Use the link in your welcome email, or open the portal, choose <b>First time here</b> and enter the code. Sign up with the email your employer has for you, so your checklist and contract find you.</p>
          <p>Admins and members can open their own portal too: your name (top right) → <b>My portal</b>.</p>` },
      { id: "account", title: "Your account", html: `<ul>
          <li><b>Forgot your password?</b> On the sign-in page choose <b>Forgot password?</b> and follow the email.</li>
          <li><b>Change your password:</b> your name (top right) → <b>Change password</b>.</li>
          <li><b>Connect your calendar</b> (Scheduler): your name → <b>Connect my calendar</b>.</li>
          <li><b>Sign out:</b> your name → <b>Sign out</b>.</li></ul>` }] },

  // ── Find and win work ──
  { id: "review", group: "win", icon: "chart", title: "Business Review", plan: "Starter", blurb: "Today, reviews, the pipeline and action items.",
    sections: [
      { id: "pages", title: "What's in it", html: `<div class="table-wrap"><table class="help-table"><tbody>
          <tr><td><b>Today</b></td><td>Deadlines in the next 14 days, your actions due this week, the pipeline by stage and the review rhythm.</td></tr>
          <tr><td><b>Reviews</b></td><td>Daily, weekly, monthly and quarterly reviews. Each opens with a live snapshot, then notes and action items.</td></tr>
          <tr><td><b>Opportunities</b></td><td>Your pipeline: bids, forecasts and projects you're chasing, by stage.</td></tr>
          <tr><td><b>Action items</b></td><td>Who does what by when, linked to a review or a record.</td></tr>
          <tr><td><b>Resources</b></td><td>Bid boards, forecast portals and other links your team uses.</td></tr>
          <tr><td><b>Activity log</b></td><td>Every add, edit, status change and delete, with who did it (admins).</td></tr></tbody></table></div>` },
      { id: "reviews", title: "Running a review", html: steps(
          ["Open Reviews and start one", `Pick the cadence (daily, weekly, monthly or quarterly). The snapshot fills itself: open and overdue actions, upcoming deadlines, what moved, follow-ups due.`],
          ["Talk through it", `Notes save as you type. Add action items with an owner and a due date.`],
          ["Print or share", `<b>Print</b> gives a clean copy.`])
        + note("Good to know", ["Wins, losses and win rate come from status changes made in Pulse, so move items to <b>Submitted</b>, <b>Won</b> or <b>Lost</b> as it happens.", "Actions not finished carry over to the next review of the same type."]) },
      { id: "csv", title: "Import and export", html: `<p><b>Import CSV</b> on a list page adds many rows at once (headers can be field names or labels). <b>Export CSV</b> downloads exactly what the current filter shows.</p>` }] },

  { id: "contacts", group: "win", icon: "users", title: "Contacts", plan: "Starter", blurb: "Customers, partners, investors, government contacts and follow-ups.",
    sections: [
      { id: "views", title: "Views", html: `<p><b>Working contacts</b> are the people you're actively talking to, <b>Follow-ups due</b> lists who to get back to, and <b>Everyone</b> is the whole list. Follow-ups due also show in every review snapshot.</p>` },
      { id: "import", title: "Import contacts", html: steps(
          ["Choose Import contacts", `Pick a spreadsheet (.xlsx) or CSV.`],
          ["Check the columns", `Pulse matches your columns to its fields; change any it got wrong.`],
          ["Upload", `Duplicates (same email) are combined, then everything uploads in one step.`]) },
      { id: "gov", title: "Contracting officers from Opportunities", html: `<p>In ${app("opportunities/", "Opportunities")}, <b>Save to Contacts</b> (or <b>Add to pipeline</b>) saves the notice's contracting officer under category <b>Government</b> with the tag <b>Contracting officer</b>. If the email is already in Contacts, Pulse updates that contact instead of adding a second one.</p>` }] },

  { id: "funding", group: "win", icon: "banknotes", title: "Funding", plan: "Starter", blurb: "Grant and loan applications and the funding catalog.",
    sections: [
      { id: "views", title: "Views", html: `<p><b>Active applications</b> are the ones in progress, <b>All applications</b> includes finished ones, <b>Open deadlines</b> shows catalog programs you can still apply to, and <b>Whole catalog</b> lists every program.</p>` },
      { id: "pipeline", title: "From catalog to application", html: `<p>Move a catalog program to <b>Identified</b> to put it in your pipeline. Funding deadlines and wins show up in every review snapshot. Grants found in ${app("opportunities/#/grants", "Opportunities → Grants")} can be added straight to Funding.</p>` }] },

  { id: "opportunities", group: "win", icon: "gov", title: "Opportunities", plan: "Pro", blurb: "Federal contracts, grants and state and local bids, checked every day.",
    sections: [
      { id: "relevance", title: "The relevance filter", html: `<p>New listings from SAM.gov, Grants.gov, APEX BidMatch and your bid sources get a <b>relevance score</b> (the chip on each card; hover it to see which words matched). Core terms add 3, related terms 2, helpful terms (consultancy, study, design…) 1, and terms like supplies or janitorial take 3 off. Title words count fully, description words count half, and a notice in one of your NAICS codes adds 2.</p>
        <p>Two rules work from your own profile (<b>My NAICS &amp; keywords</b>), so they fit any company: the <b>title must contain one of your keywords</b> (or core terms), and when a listing names <b>NAICS or PSC codes, one must be yours</b>. Listings that name no code, like most bid-source and BidMatch postings, are judged on the title. You can add PSC codes to the contracts profile, and switch either rule off in <b>Tune the filter</b>.</p>
        <p>New listings are also hidden when they're closed, when they're a site's menu link rather than a listing, when they're a plain job ad, when the title has an "always hide" word, or when they score below your strictness level. Nothing is deleted: <b>filtered out</b> shows them with the reason. Saved, added and dismissed items are never hidden.</p>
        <p><b>Less like this</b> on a card hides future listings with a word or phrase from its title. <b>Tune the filter</b> edits the terms and strictness, and can add a starter set of water and environment terms in English, French, Spanish and Portuguese. Untick <b>Relevance filter</b> to see everything.</p>` },
      { id: "overview", title: "How it works", html: `<p>Opportunities checks three sources once a day and shows what matches your company: <b>SAM.gov</b> (federal contract notices), <b>MyBidMatch</b> (federal, state, local and education bids from your APEX Accelerator) and <b>Grants.gov</b>. Grants.gov works on its own; SAM.gov and MyBidMatch each need one thing pasted once in ${app("opportunities/#/settings", "Opportunities → Settings")} by an admin.</p>` },
      { id: "sam", title: "Connect SAM.gov", sub: "about 5 minutes · admins", html: `<p>Pulse reads SAM.gov with your company's own free <b>SAM.gov public API key</b>.</p>` + steps(
          ["Sign in to SAM.gov", `Go to <a href="https://sam.gov" target="_blank" rel="noopener">sam.gov</a> and choose <b>Sign In</b>. SAM.gov uses Login.gov; create a free account with your work email if you don't have one.`],
          ["Open Account Details", `Click your name (top right) → <b>Account Details</b>.`],
          ["Get your public API key", `In the <b>Public API Key</b> section, enter your account password (and the one-time code if asked). <b>Copy the key right away</b>: SAM.gov shows it only while you stay on that page. It starts with <code>SAM-</code>.`],
          ["Paste it into Pulse", `${app("opportunities/#/settings", "Opportunities → Settings → SAM.gov API key")} → paste → <b>Save key</b>. It's stored encrypted and never shown again.`],
          ["Check it worked", `Click <b>Check now</b>. Within a few minutes <b>Recent requests</b> shows SAM.gov with a result, and matching notices appear under ${app("opportunities/#/contracts", "Contracts → SAM.gov")}.`])
        + note("Good to know", ["<b>Daily request limit.</b> A personal SAM.gov account with no role on an entity registration gets about 10 requests a day; a key from someone with a role on your company's registration (for example whoever manages your UEI) gets about 1,000. Pulse needs 10–25 a day, so use a key from someone with a role.",
          "<b>Keys expire every 90 days.</b> SAM.gov emails you first. Get a new key the same way and paste it over the old one.",
          "SAM.gov doesn't accept connections from the database's network, so Pulse sends requests through a small relay. That's set up once per Pulse installation; nothing to do per company."]) },
      { id: "bidmatch", title: "Connect MyBidMatch", sub: "a few days the first time · admins", html: `<p>MyBidMatch (by Outreach Systems) sends daily lists of bids that match your profile. It's free through <b>APEX Accelerators</b> (formerly PTACs).</p>` + steps(
          ["Become an APEX Accelerator client", `Find your local center on <a href="https://www.apexaccelerators.us" target="_blank" rel="noopener">apexaccelerators.us</a> and register (free). Ask your counselor to set up <b>MyBidMatch</b>.`],
          ["Give them your profile", `Your NAICS codes, keywords and the states you work in.`],
          ["Copy the link from a MyBidMatch email", `Each business day's email has a link like <code>https://mybidmatch.outreachsystems.com/go?sub=…</code>. Right-click it → <b>Copy link address</b>.`],
          ["Paste it into Pulse", `${app("opportunities/#/settings", "Opportunities → Settings → MyBidMatch")} → paste → <b>Save link</b>. Pulse reads the last 3 days straight away, then checks every day.`],
          ["Check it worked", `After 10–15 minutes bids appear under ${app("opportunities/#/contracts/bids", "Contracts → APEX BidMatch")}, split into Federal, State, Local and Education.`])
        + note("Good to know", ["<b>Keep the link private.</b> It opens your lists without a password. Pulse stores it encrypted.", "If it stops working (your APEX profile was renewed or changed), paste the link from the newest email.", "Change what MyBidMatch matches with your APEX counselor; in Pulse, the NAICS and keyword drop-downs narrow the list further."]) },
      { id: "grants", title: "Grants.gov", sub: "nothing to set up", html: `<p>Pulse reads every open and forecasted grant once a day and keeps the ones with your keywords or assistance listings (set in ${app("opportunities/#/profile", "My NAICS &amp; keywords")}). For each match it also looks up the agency contact. <b>Add to Funding</b> puts a grant in your Funding pipeline.</p>` },
      { id: "link", title: "Add an opportunity by link", html: `<p>Found something yourself? Click <b>Add by link</b> on the Contracts or Grants page and paste the link.</p><ul>
          <li><b>SAM.gov</b> (sam.gov/opp/…): Pulse fetches the notice with your SAM.gov key, including the contracting officer. It lands under Contracts → SAM.gov → <b>Saved</b>.</li>
          <li><b>Grants.gov</b> (search-results-detail/…): Pulse fetches the grant and its agency contact. It lands under Grants → <b>Saved</b>.</li>
          <li><b>Any other site</b> (eVA, state and city portals, school districts, foundations): add a title, the organization, type and due date. It lands under Contracts → <b>Added by link</b>.</li></ul>
        <p>From there, <b>Add to pipeline</b> (or <b>Add to Funding</b> for grants) works as usual. Adding a link that's already in Pulse just saves it.</p>` },
      { id: "sources", title: "Bid sources: any website, feed or API", html: `<p>Watch any site that lists tenders, calls or jobs: a utility's tenders page, a development bank's API, a state portal, a job board. Pulse reads each one every day (5 AM Eastern by default; admins can change the hour) and lists what it finds under Contracts → <b>Bid sources</b>, where you filter by source.</p>` + steps(
          ["Add a source", `${app("opportunities/#/sources", "Opportunities → Bid sources")} → <b>Add a source</b>. Paste the link and give it a name. Pulse works out whether it's a web page, an RSS feed or a JSON API, and reads it straight away.`],
          ["Narrow it (optional)", `Add words in <b>Only keep listings mentioning</b> (e.g. water, sanitation), or tick <b>my profile keywords</b>. Set the type (international, state, jobs…) and whether dates are day/month or month/day.`],
          ["Remove or pause", `<b>Edit</b> → <b>Remove</b> deletes the source and its listings nobody saved; untick <b>Read it every day</b> to pause it.`])
        + note("Good to know", ["Pulse reads ordinary pages that list items in tables or as links, RSS/Atom feeds and JSON APIs (it guesses the fields; you can set them under API settings).",
          "Pages built entirely by JavaScript or behind a sign-in (some e-procurement portals) can't be read automatically. Pulse says so on the source; set it to <b>Check by hand</b> and it becomes a reminder with a <b>Checked today</b> button.",
          "For APIs, put the search in the link itself, e.g. <code>qterm=water</code>."]) },
      { id: "matching", title: "My NAICS &amp; keywords: how matching works", html: `<ul>
          <li>Your profile (${app("opportunities/#/profile", "My NAICS &amp; keywords")}) decides what shows: a notice appears if it has <b>any</b> of your NAICS codes <b>or</b> any of your keywords in its title or description. Endings don't matter: "hydrological" also finds "hydrologic".</li>
          <li>Narrow the results with the NAICS and keyword drop-downs, the search box and More filters (set-aside, notice type, words to leave out).</li>
          <li><b>Dismissed stays dismissed</b> when the same notice is read again. Saved and added notices stay listed even if you change your profile.</li>
          <li><b>Add to pipeline</b> creates a Business Review opportunity and saves the contracting officer to Contacts. <b>Save to Contacts</b> saves just the contact.</li></ul>` },
      { id: "trouble", title: "Troubleshooting", html: `<div class="table-wrap"><table class="help-table"><thead><tr><th>You see</th><th>What it means</th><th>What to do</th></tr></thead><tbody>
          <tr><td>“SAM.gov never accepted the connection…”</td><td>The relay isn't set up on this Pulse installation.</td><td>Email support; it's a one-time setup.</td></tr>
          <tr><td>“SAM.gov did not answer in time”</td><td>SAM.gov was slow or down.</td><td>Nothing; Pulse tries again. If it lasts a day, check <a href="https://sam.gov" target="_blank" rel="noopener">sam.gov</a> for an outage notice.</td></tr>
          <tr><td>An error mentioning the key, 401 or 403</td><td>The key expired or was typed wrong.</td><td>Get a new key (above) and paste it in Settings.</td></tr>
          <tr><td>“Too many requests” or 429</td><td>The key's daily limit is used up.</td><td>Use a key from someone with a role on your SAM.gov registration.</td></tr>
          <tr><td>A MyBidMatch error, or no bids for days</td><td>The link changed or expired.</td><td>Paste the link from the newest MyBidMatch email.</td></tr>
          <tr><td>Contracts are empty but Recent requests shows results</td><td>Nothing matched your profile.</td><td>Add NAICS codes or keywords in My NAICS &amp; keywords.</td></tr>
        </tbody></table></div><p class="muted small">Still stuck? Email <a href="mailto:support@bluecredits.org">support@bluecredits.org</a> with a screenshot of Settings → Recent requests.</p>` }] },

  // ── Deliver ──
  { id: "projects", group: "deliver", icon: "briefcase", title: "Projects", plan: "Pro", blurb: "Schedule, tasks, team, budget vs. actual, status reports and close-out.",
    sections: [
      { id: "assign", title: "Assign work", html: `<p><b>Assign work</b> (on the Projects page, a project's page and My work) gives someone a <b>task</b> (new, or reassign an existing one), a <b>milestone</b> (new, or make them the owner of one), or a <b>role</b> on a project: project manager, approver of timesheets and expenses, or team member. Employees and contractors are added to the project so they can see it; managers and approvers need an admin or member login. In Tickets, <b>Make it a project task</b> turns a request into a task and notes it on the request. <b>My work</b> lists your tasks, the milestones you own (mark them done there) and the projects you run.</p>` },
      { id: "setup", title: "Set up a project", html: steps(
          ["New project", `Give it a manager, dates, contract value, cost budget and budget hours.`],
          ["Add milestones and tasks", `Milestones show on a timeline; tasks on a board and a list. Assign each task to someone.`],
          ["Add the team", `People assigned here can log time to the project in Timecards.`]) },
      { id: "money", title: "Budget vs. actual", html: `<p>Labor cost comes from approved and pending hours in Timecards times each person's rate; add other costs by hand. The project page compares them with the budget.</p>` },
      { id: "github", title: "Track IT work from GitHub", sub: "Pro", html: `<p>For software and IT projects, GitHub can run the task list. Pulse reads a repository's issues and milestones and keeps the project in step; developers keep working in GitHub.</p>` + steps(
          ["Connect GitHub once", `An admin opens ${app("admin/#/integrations", "Admin → Integrations")}. Either click <b>Connect GitHub</b> and pick repositories on GitHub (when your Pulse server has the app switched on), or paste a fine-grained token with <b>Issues: Read-only</b> permission. Repositories under several GitHub accounts or organizations? Connect each one (<b>Add another GitHub account or organization</b>); Pulse reads each repository through its owner's connection.`],
          ["Link repositories to a project", `In the project, open the <b>GitHub</b> tab and link one or more repositories. To track one release as a business project, narrow each link to a GitHub milestone: a "BlueCredit MVP" project linked to the <b>MVP</b> milestone of every repository involved, another for <b>Beta</b>, and so on.`],
          ["Match people", `Match GitHub usernames to people in Pulse so tasks show who's on them and appear in their My tasks.`]) + `
        <div class="table-wrap"><table class="help-table"><thead><tr><th>On GitHub</th><th>In Pulse</th></tr></thead><tbody>
          <tr><td>Milestone and its due date</td><td>Milestone on the Schedule</td></tr>
          <tr><td>Closed issue</td><td>Done (on the date it closed)</td></tr>
          <tr><td>Label <code>blocked</code></td><td>Blocked</td></tr>
          <tr><td>Assigned, or labelled <code>in progress</code> / <code>review</code></td><td>Doing</td></tr>
          <tr><td>Any other open issue</td><td>To do</td></tr>
          <tr><td>Labels <code>urgent</code>/<code>critical</code>/<code>P0</code>, <code>high</code>/<code>P1</code>, <code>low</code>/<code>P3</code></td><td>Priority</td></tr></tbody></table></div>
        <p>Issues from GitHub are read-only in Pulse: change them on GitHub and Pulse follows (instantly with the app, or every 10 minutes with a token). Pull requests aren't tasks. Unlinking a repository removes its issues from the project; nothing changes on GitHub.</p>` },
      { id: "status", title: "Status reports and close-out", html: `<p>Weekly status reports prefill from finished tasks and upcoming milestones. <b>Close-out</b> checks for open tasks, milestones, active agreements and unapproved timesheets before the project closes. Contractors see only their assigned projects and can move their own tasks.</p>` }] },

  { id: "documents", group: "deliver", icon: "clipboard", title: "Documents", blurb: "Policies and sign-offs, the compliance calendar, agreements and e-signing, and invoices.",
    sections: [
      { id: "policies", title: "Policies", sub: "Starter · admins", html: `<p>${app("agreements/#/policies", "Documents → Policies")} is your policy register: each policy's owner, version, effective date, next review and how many people have certified it.</p>` + steps(
          ["Add policies", `<b>Add from library</b> gives you plain-English starter policies for a small US company (harassment and EEO, code of conduct, workplace safety and OSHA, emergency action plan, drug-free workplace, hours and pay, time off, remote work, data security, expenses, whistleblower, records retention). Or <b>New policy</b> to write or paste your own.`],
          ["Edit and fill in", `Replace the [bracketed] parts, choose who it applies to (everyone, staff or contractors), the owner and how often to review it. Untick <b>People must read and certify it</b> for reference documents.`],
          ["Publish", `Publishing shows it to the people it applies to and asks them to certify it. Small fixes save straight to the published version; for real changes use <b>Publish new version</b>, which asks everyone to certify again.`])
        + note("Good to know", ["The starter policies are starting points, not legal advice. Check your state's rules and have counsel review them.", "Pulse flags policies due for review in the next 30 days."]) },
      { id: "certify", title: "Reading and certifying", html: `<p>People see what they need to certify in ${app("people/#/policies", "People → My policies")} (and on their apps page). They open each policy to read it, then certify any number at once with one tick and their typed name. Pulse records the name, time and version. They're asked again only when a policy gets a new version.</p><p>Admins see who has certified what in ${app("people/#/signoffs", "People → Policy sign-offs")}, with a <b>Remind</b> email for anyone who hasn't.</p>` },
      { id: "compliance", title: "Compliance calendar", sub: "Starter", html: `<p>${app("agreements/#/compliance", "Documents → Compliance calendar")} keeps the dates that are easy to miss: SAM.gov renewal, state annual report, tax filings, insurance renewals, OSHA 300A posting, labor law posters, certifications and licenses. <b>Add common items</b> suggests the usual ones for a small US company; set the real dates. Marking a repeating item <b>Done</b> moves it to its next due date.</p>` },
      { id: "invoices", title: "Invoices", sub: "Pro · admins", html: steps(
          ["Set up once", `${app("agreements/#/invoice-settings", "Invoices → Settings")}: number prefix, starting number, payment terms and how to pay (printed on every invoice). Your company name and address come from Agreements → Templates; your logo from Workspace settings.`],
          ["Create an invoice", `Pick the client from Contacts (or type it) and the project. <b>Add approved hours</b> adds a line per person with their approved timecard hours in the dates you choose, at the project's billing rate. Add other lines, a discount or tax.`],
          ["Send and get paid", `<b>Print / PDF</b> to save it, <b>Email</b> to open a message to the client (attach the PDF), then <b>Mark sent</b>. Overdue invoices are flagged. <b>Mark paid</b> records the date and amount.`]) },
      { id: "employment", title: "Employment agreements", html: `<p>For employees, use the <b>Employment Agreement</b> template: job title, start date, schedule and overtime classification, pay, benefits, time off, introductory period, company policies, confidentiality and at-will terms (or notice outside the US). Start it from the new hire's onboarding in People so their details fill in; once they sign online, their onboarding checklist ticks the agreement items. Have them sign the Confidentiality and Assignment Agreement too.</p>` },

      { id: "create", title: "Agreements: create and send", sub: "Pro", html: steps(
          ["New agreement", `Choose a template (Employment, Teaming, Consulting, Confidentiality &amp; Assignment, Amendment) and the governing law. Fill in the form; special provisions are added as numbered sections.`],
          ["Exhibits", `Keep the contract's standard wording and put the deal-specific detail in exhibits: <b>Statement of Work</b> (starts from an outline), rate schedule, key personnel, flow-down clauses, insurance, or your own. Type an exhibit or attach a PDF or Word file. Exhibits go after the signatures, a standard <b>Exhibits</b> clause makes them part of the agreement (the body wins a conflict), and an attached file is named by its SHA-256 fingerprint so it can't be swapped. Signers download attached exhibits from their signing link. In a Consulting Agreement you can leave Services and Deliverables blank and let the Statement of Work cover them.`],
          ["Send for signature", `Sending locks the text. Each signer gets a private link and signs with a typed or drawn signature; no Pulse account needed.`],
          ["Active", `When everyone has signed the agreement becomes Active, and a linked onboarding checklist ticks the matching items.`])
        + note("Good to know", ["Signed on paper or elsewhere? Use <b>Upload signed copy</b> (up to 10 MB).", "Company details (legal name, entity, address, signer) and template wording are in <b>Agreements → Templates</b>.", "The wording is a starting point, not legal advice: have counsel review it."]) },
      { id: "life", title: "Agreement lifecycle", html: `<p>Draft → Out for signature → Active → (Amendments) → Expired or Terminated → close-out checklist → Closed out. Declined or voided agreements can be copied into a corrected draft.</p>` }] },

  { id: "people", group: "deliver", icon: "user-plus", title: "People and Hiring", plan: "Starter", blurb: "Openings, candidates, interviews and scorecards; then onboarding and offboarding.",
    sections: [
      { id: "openings", title: "Post an opening", sub: "Hiring is part of Pro", html: steps(
          ["New opening", `In ${app("people/#/openings", "People → Openings")} add the role, location, engagement (contractor, consultant, intern, advisor or employee), schedule, description and what you'll score candidates on.`],
          ["Share the apply link", `Set it to <b>Open</b> and copy its public apply link. Anyone with the link can read the description and apply with a resume; no sign-in needed.`],
          ["Applications arrive", `Each application goes straight onto the <b>Candidates</b> board in the first stage.`]) },
      { id: "careers", title: "Put your openings on your website", html: `<p>Instead of copying apply links by hand, turn on the <b>careers page</b>: one public page that lists every <b>Open</b> opening and updates itself when you open or close one.</p>` + steps(
          ["Turn it on", `${app("people/#/hiring-setup", "People → Hiring setup → Careers page")}: tick <b>Show my open positions</b>, choose the page address (for example <code>acme-robotics</code>) and <b>Save careers page</b>.`],
          ["Link to it", `Copy the link into your website's Careers menu, your email signature or LinkedIn.`],
          ["Or embed it", `Copy the embed code and paste it into your own careers page (WordPress, Squarespace, Wix or plain HTML). Your openings appear right there; <b>View and apply</b> opens the Pulse apply page.`])
        + note("Good to know", ["Only openings set to <b>Open</b> are listed. Drafts, on hold, filled and closed ones are not.", "Turning the careers page off hides it straight away; each opening's own apply link keeps working while the opening is Open.", "Search engines can list the jobs from the careers page (Google for Jobs)."]) },
      { id: "candidates", title: "Review candidates and interview", html: `<ul>
          <li>Move candidates across the board's stages. Rejecting asks for a reason.</li>
          <li><b>Schedule interview</b> picks interviewers and a time. Interviewers see only the candidates they're assigned to; admins see everyone.</li>
          <li><b>Scorecards are blind:</b> an interviewer sees other scores only after submitting their own.</li>
          <li><b>Hire</b> marks the candidate hired and starts their onboarding checklist.</li></ul>` },
      { id: "org", title: "Org chart", html: `<p>${app("people/#/org", "People → Org chart")} shows your company's structure. Everyone can see it; admins build it.</p>` + steps(
          ["Start from a template", `Pick the structure closest to yours (startup with a leadership team, consulting or engineering firm, government contractor, software startup, owner-led business, field services or construction, nonprofit). Tick the leaders you have, rename them, and list your departments; each gets a head who reports to the leader you choose.`],
          ["Put people in", `Click a box to choose who holds it, change its title, department or manager, or add a position under it. Drag a box onto another to change who it reports to. Contractors, advisors and board members show with a dashed border.`],
          ["Let hiring fill it", `Link each opening to a position (in the opening, or a new position under a manager). When you mark someone hired, they go straight into it. Adding someone in Team &amp; onboarding can place them too. Offboarding sets the position back to Open.`]) },
      { id: "devices", title: "Devices", html: `<p>Issue laptops, phones and other equipment from a person's page in Team &amp; onboarding (pick from the register in Tickets → Assets, or add a new device). They confirm receipt in My checklist with their name. ${app("people/#/devices", "People → Devices")} shows what's out, what hasn't been confirmed, and anything still with people who have left. You can't finish offboarding someone until each device is marked returned or lost.</p>` },
      { id: "onboarding", title: "Team, onboarding and offboarding", html: `<p>${app("people/#/people", "Team &amp; onboarding")} lists employees, contractors, consultants and interns with their checklist: paperwork, access and equipment from first day to last. New people start from the <b>Checklist template</b> (changing it doesn't change checklists already started). Each person sees what's left under <b>My checklist</b>. Offboarding runs the same way at the end.</p>` }] },

  // ── Every day ──
  { id: "timecards", group: "daily", icon: "timer", title: "Timecards", plan: "Starter", blurb: "Log hours and time off, submit expenses, approve both.",
    sections: [
      { id: "log", title: "Log your week", html: steps(
          ["Open My timesheet", `Enter hours by project for each day. Work hours can't be entered for future days; <b>Paid time off</b> and <b>Company holiday</b> can (add them from <b>+ Add a project or time off</b>). Sick time is logged on or after the day.`],
          ["Start a project if it isn't there", `Admins and members can choose <b>+ New project…</b>, give it a budget in hours and a rate, and log to it straight away. It's the same project in Projects, where milestones, tasks and costs live. Each project row shows hours used against its budget and warns when it goes over.`],
          ["Submit the week", `Add a note if needed and submit it for approval.`],
          ["If it comes back", `A rejected week shows the reason; fix it and submit again.`]) },
      { id: "approve", title: "Approve timesheets", html: `<p>Admins approve every timesheet; project approvers approve weeks with hours on their projects. <b>Reports</b> show hours and amounts by project and person (approved hours come from approved weeks). Admins add projects, limit them to assigned people, and set rates and budgets under <b>Projects</b>.</p>` },
      { id: "timeoff", title: "Time off and holidays", html: `<p>Staff (admins, members and employees) log Holiday, PTO and Sick hours on their timesheet next to project work; contractors log project work only. Admins list company holidays under <b>Settings</b> (one click adds the US federal holidays for a year). When holidays are listed, Holiday hours go on those dates only. <b>Reports</b> show time off by person. Requesting time off ahead still goes through Tickets.</p>` },
      { id: "expenses", title: "Expenses", html: steps(
          ["Start a report", `<b>Expenses → New expense report</b>. Add each expense: date, category, merchant, purpose, and a receipt photo or PDF. Mileage is miles times the company rate (Settings; the IRS business rate is 76¢ a mile from July 1, 2026).`],
          ["Charge it to a project", `Pick a project and tick <b>Billable</b> if the client pays for it. Approved expenses on a project appear in its costs in Projects.`],
          ["Submit", `Receipts are needed for anything at or above the receipt threshold (default $75, the IRS rule), except mileage and per diem.`],
          ["Approval and reimbursement", `Admins approve (or the project's approver, when every line is on their projects); nobody approves their own when another admin exists. A sent-back report shows the reason. An admin records the reimbursement with a date and reference.`]) }] },

  { id: "tickets", group: "daily", icon: "ticket", title: "Tickets", plan: "Starter", blurb: "Equipment, purchases, time off, travel, access and IT help.",
    sections: [
      { id: "software", title: "Software requests and the approved list", html: `<p><b>Software</b> lists the software your company has approved, with its license and cost. Pick one and choose <b>Request</b>, or choose <b>Software request</b> under New request, where the same list appears. Pre-approved software goes straight to the admins to set up; software marked <b>needs approval</b>, or anything not on the list, goes to an approver first (and needs a reason). Admins add, edit and remove software on the Software page (or start from suggestions), including install notes that the requester sees once it's approved.</p>` },
      { id: "request", title: "Make a request", html: `<p>Choose a type: IT support, Software request, New equipment, Purchase or expense, Time off, Travel, Access or account, Asset problem, Return an asset, or Other. Equipment, purchases, time off, travel and access need approval: pick an approver (by default an admin).</p>` },
      { id: "approve", title: "Approvals and fulfilment", html: `<ul><li>Nobody approves their own request. Rejecting needs a reason, which the requester sees.</li>
          <li>Admins (or whoever it's assigned to) start and finish approved requests. Finishing <b>Return an asset</b> checks the asset back in; <b>Asset problem</b> marks it In repair.</li>
          <li>A request is visible only to the requester, the approver, the assignee and admins.</li>
          <li><b>My assets</b> shows what's assigned to you; admins manage the register (add, assign, import, export).</li></ul>` }] },

  { id: "scheduler", group: "daily", icon: "calendar", title: "Scheduler", plan: "Enterprise", blurb: "See the team's free/busy from Google or Outlook and book meetings.",
    sections: [
      { id: "connect", title: "Connect your calendar", html: steps(
          ["Open My calendars", `Your name (top right) → <b>Connect my calendar</b>, or ${app("scheduler/#/connect", "Scheduler → My calendars")}.`],
          ["Choose Google or Outlook", `Sign in and allow access. Pulse reads only when you're busy, never titles or details.`]) },
      { id: "find", title: "Find a time", html: `<p><b>Team calendar</b> shows everyone's busy times (titles stay private). <b>Find a time</b> picks people and shows open slots on weekdays over the next two weeks; booking sends the invites from your calendar.</p>` }] },

  { id: "chief", group: "daily", icon: "sparkles", title: "Chief of Staff", plan: "Enterprise", blurb: "Your AI chief of staff: a morning brief, answers and reminders.",
    sections: [
      { id: "brief", title: "Your brief", html: `<p><b>My brief</b> sums up your day: deadlines, follow-ups, approvals, timecards and meetings. Draft emails it suggests are for you to review and send from your own email.</p>` },
      { id: "ask", title: "Ask and reminders", html: `<p><b>Ask</b> answers questions about your work in Pulse. <b>Reminders</b> are yours only; due reminders also show on your apps page and in the brief. Admins can rename the assistant in Workspace settings.</p>` }] },

  // ── Admin and billing ──
  { id: "admin", group: "admin", icon: "cog", title: "Team and workspace settings", blurb: "Invite people, roles, codes, lists, logo and apps.",
    sections: [
      { id: "close", title: "Close or archive the business", html: `<p>In <b>Workspace settings → Close the business</b>, an admin can:</p><ul>
          <li><b>Download everything</b>: every record as one JSON file (file contents and secrets left out). Each list page also has Export CSV.</li>
          <li><b>Archive</b>: everything becomes read-only. People can still sign in, look things up and export; nothing can be added or changed, nobody new can join, and bid checks and GitHub sync stop. A bar on every page says it's archived. Reopen any time and everything, including the join codes, comes back.</li>
          <li><b>Close</b>: archives it and deletes it permanently 30 days later. Reopening before then cancels the deletion. You type the business name to confirm.</li>
          <li><b>Delete now</b> is still there for an immediate, permanent delete.</li></ul>` },
      { id: "team", title: "Invite and manage the team", html: steps(
          ["Add new hires in People first", `${app("people/#/people", "People → Team &amp; onboarding")} with their work email, so their checklist, contract and devices are waiting.`],
          ["Send the invite", `Your name → <b>Team and access</b>. There are three codes: <b>Staff</b> (members, every app), <b>Employees</b> (the employee portal) and <b>Contractors</b> (the portal, free). <b>Invite…</b> writes the welcome email with a link that fills the code in.`],
          ["Set roles", `Change anyone's role from the drop-down: Admin, Member, Employee or Contractor. Moving someone to Employee or Contractor takes away contacts, pipeline, funding and bids.`],
          ["Remove access", `<b>Change code</b> stops new sign-ups with the old code. <b>Turn off</b> removes someone immediately.`]) },
      { id: "integrations", title: "Integrations", html: `<p>Your name → <b>Integrations</b> (admins). <b>GitHub</b> feeds issues and milestones into Projects; see ${app("help/#projects/github", "Track IT work from GitHub")}.</p>` },
      { id: "settings", title: "Workspace settings", html: `<p>Your name → <b>Workspace settings</b>: company name and logo, the lists used in drop-downs, which apps are on, and the Chief of Staff's name.</p>` }] },

  { id: "billing", group: "admin", icon: "banknotes", title: "Plans and billing", blurb: "Starter, Pro and Enterprise; the free trial; paying.",
    sections: [
      { id: "plans", title: "Plans", html: `<div class="table-wrap"><table class="help-table"><thead><tr><th>Plan</th><th>Per user / month</th><th>Apps</th></tr></thead><tbody>
          <tr><td>${plan("Starter")}</td><td>$3</td><td>Business Review, Contacts, Funding, Timecards, Tickets, People (team and onboarding), Documents (policies, sign-offs and the compliance calendar). Up to 10 users.</td></tr>
          <tr><td>${plan("Pro")}</td><td>$6</td><td>Everything in Starter, plus Opportunities, Projects, Agreements and e-signing, Invoices and Hiring.</td></tr>
          <tr><td>${plan("Enterprise")}</td><td>$10</td><td>Everything in Pro, plus Chief of Staff and Scheduler. Priority support.</td></tr></tbody></table></div>
        <p>Admins, members and employees count as users. Contractors and consultants are free. Paying yearly costs 10 months.</p>` },
      { id: "trial", title: "Free trial", html: `<p>Every new workspace gets 14 days of Pro, no card needed. When the trial ends, apps outside your plan show a lock until an admin chooses a plan; nothing is deleted.</p>` },
      { id: "pay", title: "Choose or change a plan", html: steps(
          ["Open Plan and billing", `Your name (top right) → <b>Plan and billing</b> (admins).`],
          ["Choose a plan", `Pick monthly or yearly, then approve the subscription on PayPal (PayPal balance, bank or card). You come back to Pulse and the plan switches on. If online payment isn't on yet, you can ask for an invoice instead.`],
          ["Users", `You're billed for staff users (admins, members and employees). Contractors don't count. After adding people, press <b>Update user count on the subscription</b> and approve the new amount on PayPal.`]) },
      { id: "manage", title: "Change, update or cancel", html: `<p><b>Change plan</b>: choose another plan; PayPal asks you to approve the new amount. <b>Payment method and receipts</b> open your PayPal account. <b>Cancel subscription</b> stops future charges; you keep your plan until the paid period ends, then the workspace drops to Starter. Nothing is deleted. Archiving or closing the business cancels the subscription too.</p>` }] },

  { id: "support", group: "admin", icon: "chat", title: "Contact support", blurb: "Can't find the answer? We'll help.",
    sections: [{ id: "email", title: "Email us", html: `<p>Email <a href="mailto:support@bluecredits.org">support@bluecredits.org</a>. Tell us your company name, what you were doing and what you saw; a screenshot helps.</p>` }] },
];

// ── rendering ──
const plain = (h) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const INDEX = TOPICS.flatMap((t) => t.sections.map((s) => ({ t, s, text: (t.title + " " + s.title + " " + plain(s.html)).toLowerCase() })));

function nav(active) {
  $("#hcNav").innerHTML = GROUPS.map(([g, label]) => `<div class="hc-group"><div class="hc-glabel">${label}</div>${TOPICS.filter((t) => t.group === g).map((t) =>
    `<a href="#${t.id}" class="${t.id === active ? "on" : ""}" ${t.id === active ? 'aria-current="page"' : ""}>${ic(t.icon)}<span>${t.title}</span></a>`).join("")}</div>`).join("");
}
function home() {
  nav(null);
  $("#hcMain").innerHTML = `<div class="hc-hero"><h1>How can we help?</h1><p class="muted">Guides for every Pulse app: getting set up, everyday tasks and fixing problems.</p></div>
    <div class="hc-cards">${TOPICS.map((t) => `<a class="hc-card" href="#${t.id}"><span class="hub-ic">${ic(t.icon)}</span><span><b>${t.title}</b>${t.plan ? plan(t.plan) : ""}<small>${t.blurb}</small></span></a>`).join("")}</div>`;
}
function article(id, sec) {
  const t = TOPICS.find((x) => x.id === id); if (!t) return home();
  nav(id);
  const g = GROUPS.find((x) => x[0] === t.group)[1];
  $("#hcMain").innerHTML = `<nav class="hc-crumb" aria-label="Breadcrumb"><a href="#">Help Center</a> › <span>${g}</span> › <span>${t.title}</span></nav>
    <div class="hc-head"><span class="hub-ic">${ic(t.icon)}</span><div><h1>${t.title} ${t.plan ? plan(t.plan) : ""}</h1><p class="muted">${t.blurb}</p></div></div>
    ${t.sections.length > 2 ? `<nav class="help-toc" aria-label="On this page">${t.sections.map((s) => `<a href="#${t.id}/${s.id}">${s.title}</a>`).join("")}</nav>` : ""}
    ${t.sections.map((s) => `<section class="panel help-sec" id="s-${s.id}"><h2>${s.title}${s.sub ? ` <small>${s.sub}</small>` : ""}</h2>${s.html}</section>`).join("")}
    <p class="muted small hc-foot">Didn't find it? Email <a href="mailto:support@bluecredits.org">support@bluecredits.org</a>.</p>`;
  if (sec) setTimeout(() => document.getElementById("s-" + sec)?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  else window.scrollTo(0, 0);
  document.title = t.title + " · Pulse Help";
}
function search(q) {
  q = q.trim().toLowerCase(); if (!q) return route();
  nav(null);
  const words = q.split(/\s+/), hits = INDEX.filter((x) => words.every((w) => x.text.includes(w)));
  const snip = (x) => { const tx = plain(x.s.html), i = tx.toLowerCase().indexOf(words[0]); return (i > 60 ? "…" : "") + tx.slice(Math.max(0, i - 60), i + 140) + "…"; };
  $("#hcMain").innerHTML = `<h1 class="hc-sh">${hits.length} result${hits.length === 1 ? "" : "s"} for “${q.replace(/[<>&"]/g, "")}”</h1>
    ${hits.length ? `<div class="hc-results">${hits.map((x) => `<a href="#${x.t.id}/${x.s.id}"><b>${x.s.title}</b><small>${x.t.title}</small><span>${snip(x).replace(/[<>]/g, "")}</span></a>`).join("")}</div>`
      : `<p class="muted">Nothing found. Try other words, or email <a href="mailto:support@bluecredits.org">support@bluecredits.org</a>.</p>`}`;
}
function route() {
  const [id, sec] = location.hash.replace(/^#\/?/, "").split("/");
  document.title = "Pulse Help Center";
  id ? article(id, sec) : home();
  $("#hcSide").classList.remove("open");
}
window.addEventListener("hashchange", () => { $("#hcSearch").value = ""; route(); });
$("#hcSearch").addEventListener("input", (e) => search(e.target.value));
$("#hcMenu").addEventListener("click", () => $("#hcSide").classList.toggle("open"));
route();
