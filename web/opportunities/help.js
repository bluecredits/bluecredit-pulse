/* Pulse · Opportunities → Help: how to connect SAM.gov and MyBidMatch, how matching works, and what the errors mean.
   Opened from the menu, or with #/help/sam, #/help/bidmatch, #/help/trouble to jump to a section. */
"use strict";
function Help(section) {
  const admin = S.profile?.role === "admin";
  const step = (title, body) => `<li><strong class="st">${title}</strong><span>${body}</span></li>`;
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Help: connecting your sources</h1><p class="muted">Opportunities checks three sources once a day. Grants.gov works on its own; SAM.gov and MyBidMatch each need one thing from you, pasted once in <a href="#/settings">Settings</a>${admin ? "" : " by an admin"}.</p></div></div>
    <nav class="help-toc" aria-label="On this page">${[["sam", "Connect SAM.gov"], ["bidmatch", "Connect MyBidMatch"], ["grants", "Grants.gov"], ["matching", "How matching works"], ["trouble", "Troubleshooting"]].map(([k, l]) => `<a href="#/help/${k}">${l}</a>`).join("")}</nav>

    <section class="panel help-sec" id="help-sam"><h2>${icon("gov")} Connect SAM.gov <small>about 5 minutes · admins</small></h2>
      <p>SAM.gov publishes federal contract notices (solicitations, sources sought, presolicitations). Pulse reads them with your company's own free <b>SAM.gov public API key</b>.</p>
      <ol class="help-steps">
        ${step("Sign in to SAM.gov", `Go to <a href="https://sam.gov" target="_blank" rel="noopener">sam.gov</a> and choose <b>Sign In</b>. SAM.gov uses Login.gov; create a free account with your work email if you don't have one.`)}
        ${step("Open Account Details", `Click your name (top right) → <b>Account Details</b>.`)}
        ${step("Get your public API key", `In the <b>Public API Key</b> section, enter your account password (and the one-time code if asked) to request or view the key. <b>Copy it right away</b>: SAM.gov shows it only while you stay on that page. It starts with <code>SAM-</code>.`)}
        ${step("Paste it into Pulse", `Here: <a href="#/settings">Opportunities → Settings → SAM.gov API key</a> → paste → <b>Save key</b>. It's stored encrypted and never shown again.`)}
        ${step("Check it worked", `Click <b>Check now</b> in Settings. Within a few minutes <b>Recent requests</b> shows SAM.gov with a result, and matching notices appear under <a href="#/contracts">Contracts → SAM.gov</a>.`)}
      </ol>
      <div class="help-note"><b>Good to know</b><ul>
        <li><b>Daily request limit.</b> SAM.gov limits requests per key by role. A personal account with no role on a SAM.gov entity registration gets very few (about 10 a day); a key from someone with a role on your company's registration (for example, the person who manages your UEI) gets about 1,000. Once a day, Pulse needs 10–25 requests, so use a key from someone with a role.</li>
        <li><b>Keys expire every 90 days.</b> SAM.gov emails you before it does. Get a new key the same way and paste it over the old one. Pulse shows an error in Settings if the key stops working.</li>
        <li><b>Already set up:</b> SAM.gov doesn't accept connections from the database's network, so Pulse sends its requests through a small relay (the <code>sam-relay</code> function). It's a one-time setup per Pulse installation, done once by whoever runs Pulse; nothing to do per company.</li>
      </ul></div></section>

    <section class="panel help-sec" id="help-bidmatch"><h2>${icon("inbox")} Connect MyBidMatch <small>a few days the first time · admins</small></h2>
      <p>MyBidMatch (by Outreach Systems) sends daily lists of federal, state, local and education bids that match your profile. It's offered free through <b>APEX Accelerators</b> (formerly PTACs), the government-contracting counseling program. Pulse reads those lists, sorts them by level and shows them under <a href="#/contracts/bids">Contracts → APEX BidMatch</a>.</p>
      <ol class="help-steps">
        ${step("Become an APEX Accelerator client", `Find your local center on <a href="https://www.apexaccelerators.us" target="_blank" rel="noopener">apexaccelerators.us</a> and register as a client (free). Ask your counselor to set up <b>MyBidMatch</b>.`)}
        ${step("Give them your profile", `Your NAICS codes, keywords and the states you work in. MyBidMatch matches on these; you can ask to change them any time.`)}
        ${step("Open a MyBidMatch email", `Once it's set up you get an email each business day. Find the link that opens your matches; it looks like <code>https://mybidmatch.outreachsystems.com/go?sub=…</code>. Right-click it → <b>Copy link address</b>.`)}
        ${step("Paste it into Pulse", `<a href="#/settings">Opportunities → Settings → MyBidMatch</a> → paste → <b>Save link</b>. Pulse reads the last 3 days straight away, then checks every day.`)}
        ${step("Check it worked", `After 10–15 minutes, bids appear under <a href="#/contracts/bids">Contracts → APEX BidMatch</a>, split into Federal, State, Local and Education.`)}
      </ol>
      <div class="help-note"><b>Good to know</b><ul>
        <li><b>Keep the link private.</b> It opens your MyBidMatch lists without a password. Pulse stores it encrypted.</li>
        <li><b>If it stops working</b> (your APEX profile was renewed or changed), paste the link from the newest email.</li>
        <li><b>What you see is what MyBidMatch matched.</b> Change the matching with your APEX counselor; in Pulse, the NAICS and keyword drop-downs narrow the list further.</li>
      </ul></div></section>

    <section class="panel help-sec" id="help-grants"><h2>${icon("banknotes")} Grants.gov <small>nothing to set up</small></h2>
      <p>Grants.gov needs no key. Pulse reads every open and forecasted grant once a day and keeps the ones with your grant keywords or assistance listings (set them in <a href="#/profile">My NAICS &amp; keywords</a>). For each matching grant it also looks up the agency contact.</p></section>

    <section class="panel help-sec" id="help-matching"><h2>${icon("search")} How matching works</h2>
      <ul>
        <li><b>Your profile</b> (<a href="#/profile">My NAICS &amp; keywords</a>) decides what shows: a notice appears if it has <b>any</b> of your NAICS codes <b>or</b> any of your keywords in its title or description. Endings don't matter: "hydrological" also finds "hydrologic".</li>
        <li><b>Narrow</b> the results with the NAICS and keyword drop-downs, the search box and More filters (set-aside, notice type, words to leave out).</li>
        <li><b>Dismissed stays dismissed</b> when the same notice is read again. Saved and added notices stay listed even if you change your profile.</li>
        <li><b>Add to pipeline</b> creates a Business Review opportunity and saves the contracting officer to Contacts. <b>Save to Contacts</b> saves just the contact.</li>
      </ul></section>

    <section class="panel help-sec" id="help-trouble"><h2>${icon("wrench")} Troubleshooting</h2>
      <div class="table-wrap"><table class="help-table"><thead><tr><th>You see</th><th>What it means</th><th>What to do</th></tr></thead><tbody>
        <tr><td>“SAM.gov never accepted the connection…”</td><td>The relay isn't set up on this Pulse installation.</td><td>Whoever runs Pulse deploys the <code>sam-relay</code> function once (see the README).</td></tr>
        <tr><td>“SAM.gov did not answer in time”</td><td>SAM.gov was slow or down.</td><td>Nothing; Pulse tries again. If it lasts a day, check <a href="https://sam.gov" target="_blank" rel="noopener">sam.gov</a> for an outage notice.</td></tr>
        <tr><td>An error mentioning the key, 401 or 403</td><td>The key expired or was typed wrong.</td><td>Get a new key (steps above) and paste it in Settings.</td></tr>
        <tr><td>“Too many requests” or 429</td><td>The key's daily limit is used up.</td><td>Use a key from someone with a role on your SAM.gov registration, or keep the schedule at once a day.</td></tr>
        <tr><td>A MyBidMatch error, or no bids for days</td><td>The link changed or expired.</td><td>Paste the link from the newest MyBidMatch email.</td></tr>
        <tr><td>Contracts are empty but Recent requests shows results</td><td>Nothing matched your profile.</td><td>Add NAICS codes or keywords in <a href="#/profile">My NAICS &amp; keywords</a>.</td></tr>
        <tr><td>“This app is part of the Pro plan”</td><td>Your workspace is on Starter.</td><td>An admin upgrades in <a href="../admin/#/billing">Admin → Plan and billing</a>.</td></tr>
      </tbody></table></div>
      <p class="muted small">Still stuck? Email <a href="mailto:support@bluecredits.org">support@bluecredits.org</a> with a screenshot of Settings → Recent requests.</p></section>`;
  if (section) setTimeout(() => document.getElementById("help-" + section)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
}
