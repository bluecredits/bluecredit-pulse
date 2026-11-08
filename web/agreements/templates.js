/* Pulse · Agreements — built-in templates, governing-law choices and the template renderer.
   A template is HTML with {{placeholders}}:
     {{name}}                      a field (HTML-escaped)
     {{#if name}}…{{/if}}          shown when the field has a value (or is "yes"); {{#unless name}}…{{/unless}} the opposite
     {{#each name}}<li>{{.}}</li>{{/each}}   one per line of a multi-line field
   Workspaces can copy a template and edit its wording (Agreements → Templates). These starting texts are not legal
   advice: have counsel review them for the places you use them. */
"use strict";

/* ---------------------------------------------------------------- governing law */
const US_STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "District of Columbia", "Florida", "Georgia",
  "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
  "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"];
const JURISDICTIONS = {
  "United States": { regions: US_STATES, label: "State" },
  "Canada": { regions: ["Alberta", "British Columbia", "Manitoba", "New Brunswick", "Newfoundland and Labrador", "Nova Scotia", "Ontario", "Prince Edward Island", "Quebec", "Saskatchewan"], label: "Province" },
  "Australia": { regions: ["Australian Capital Territory", "New South Wales", "Northern Territory", "Queensland", "South Australia", "Tasmania", "Victoria", "Western Australia"], label: "State or territory" },
  "United Kingdom": { regions: ["England and Wales", "Scotland", "Northern Ireland"], label: "Jurisdiction" },
  "Kenya": { regions: [], label: "" }, "Rwanda": { regions: [], label: "" }, "Uganda": { regions: [], label: "" }, "Tanzania": { regions: [], label: "" },
  "South Africa": { regions: [], label: "" }, "Nigeria": { regions: [], label: "" }, "Ghana": { regions: [], label: "" }, "India": { regions: [], label: "" },
  "Ireland": { regions: [], label: "" }, "Germany": { regions: [], label: "" }, "Netherlands": { regions: [], label: "" }, "Singapore": { regions: [], label: "" },
  "United Arab Emirates": { regions: [], label: "" }, "Chile": { regions: [], label: "" }, "Mexico": { regions: [], label: "" }, "Brazil": { regions: [], label: "" },
};
const COMMONWEALTH_STATES = ["Kentucky", "Massachusetts", "Pennsylvania", "Virginia"];
// "the Commonwealth of Virginia", "the State of Queensland, Australia", "England and Wales", "the Republic of Kenya" …
function lawPlace(country, region) {
  if (!country) return "";
  if (country === "United States") {
    if (!region) return "the United States";
    if (region === "District of Columbia") return "the District of Columbia";
    return (COMMONWEALTH_STATES.includes(region) ? "the Commonwealth of " : "the State of ") + region;
  }
  if (country === "United Kingdom") return region || "England and Wales";
  if (country === "Canada") return region ? `the Province of ${region}, Canada` : "Canada";
  if (country === "Australia") return region ? `${/Territory/.test(region) ? "the " : "the State of "}${region}, Australia` : "Australia";
  const republics = { Kenya: "the Republic of Kenya", Rwanda: "the Republic of Rwanda", Uganda: "the Republic of Uganda", Tanzania: "the United Republic of Tanzania",
    "South Africa": "the Republic of South Africa", Nigeria: "the Federal Republic of Nigeria", Ghana: "the Republic of Ghana", India: "the Republic of India",
    Singapore: "the Republic of Singapore", Chile: "the Republic of Chile", Netherlands: "the Netherlands", "United Arab Emirates": "the United Arab Emirates" };
  return (region ? region + ", " : "") + (republics[country] || country);
}
function venuePlace(country, region) {
  const p = lawPlace(country, region);
  return country === "United States" ? `the state or federal courts located in ${p.replace(/^the /, "the ")}` : `the courts of ${p}`;
}
// places where a post-relationship non-compete is generally void or heavily restricted (flagged, not decided, by Pulse)
function noncompeteWarning(country, region) {
  if (country !== "United States") return country ? "Check whether post-relationship non-competes are enforceable under the chosen law." : "";
  if (["California", "North Dakota", "Oklahoma", "Minnesota"].includes(region)) return `${region} generally does not enforce non-compete clauses. Consider turning the non-compete off.`;
  if (["Virginia", "Maryland", "Washington", "Oregon", "Illinois", "Colorado", "Massachusetts", "Maine", "New Hampshire", "Rhode Island", "District of Columbia"].includes(region))
    return `${region} limits non-competes (for example, for lower-paid workers or by notice and pay rules). Check before including one.`;
  return "";
}

/* ---------------------------------------------------------------- shared field groups */
const F_COMPANY = [
  { key: "company_name", label: "Company legal name", group: "Your company", required: true, from: "legal.name" },
  { key: "company_entity", label: "Company type and place", group: "Your company", placeholder: "a Delaware corporation", from: "legal.entity" },
  { key: "company_address", label: "Company address", group: "Your company", from: "legal.address" },
  { key: "company_signer_name", label: "Signs for the company", group: "Your company", required: true, from: "legal.signer_name" },
  { key: "company_signer_title", label: "Their title", group: "Your company", from: "legal.signer_title" },
  { key: "company_signer_email", label: "Their email", group: "Your company", type: "email", from: "legal.signer_email" },
];
const F_LAW = [
  { key: "law_country", label: "Governing law: country", group: "Governing law", type: "country", required: true, from: "legal.law_country", default: "United States" },
  { key: "law_region", label: "State / province", group: "Governing law", type: "region", from: "legal.law_region" },
];
const F_PARTY = (who) => [
  { key: "party_name", label: `${who} legal name`, group: who, required: true },
  { key: "party_entity", label: `${who} type and place`, group: who, placeholder: "a District of Columbia limited liability company" },
  { key: "party_address", label: `${who} address`, group: who, required: true },
  { key: "party_signer_name", label: "Signs for them", group: who, required: true },
  { key: "party_signer_title", label: "Their title", group: who },
  { key: "party_signer_email", label: "Their email (gets the signing link)", group: who, type: "email", required: true },
  { key: "party_signer_phone", label: "Their phone", group: who },
];

/* ---------------------------------------------------------------- templates */
const SIG_NOTE = `<p class="agr-small">This Agreement may be executed in counterparts and by electronic signature, each of which is an original and together one instrument.</p>`;

const TEAMING = `
<h1>TEAMING AGREEMENT</h1>
<p>This Teaming Agreement (this "Agreement") is made and entered into effective as of {{effective_date_long}} (the "Effective Date"), by and between <b>{{prime_name}}</b>, {{prime_entity}} with its principal office at {{prime_address}} ("{{prime_short}}" or "Prime"), and <b>{{sub_name}}</b>, {{sub_entity}} with its principal office at {{sub_address}} ("{{sub_short}}" or "Subcontractor"). Prime and Subcontractor are referred to collectively as the "Parties" and individually as a "Party."</p>
<h2>RECITALS</h2>
<p>WHEREAS, Prime intends to submit a proposal as prime contractor in response to {{program}} (the "Program");</p>
<p>WHEREAS, the Parties, because of their diverse and complementary capabilities, have determined that they would benefit from a teaming arrangement in order to pursue this business opportunity and to submit a responsive proposal to the customer;</p>
<p>WHEREAS, Prime intends to respond to the Program as prime contractor, with Subcontractor serving as a subcontractor for the work described in Exhibit A;</p>
<p>WHEREAS, the Parties desire to define their mutual rights and obligations in connection with the preparation and submission of the proposal and any resulting negotiations; and</p>
<p>WHEREAS, this Agreement is entered into to enable each Party to benefit from the capabilities of the other Party in areas of work not independently available within the respective organizations.</p>
<p>NOW, THEREFORE, in consideration of the mutual promises contained herein, the Parties agree as follows:</p>
<ol class="agr-sections">
<li><b>Proposal Effort.</b> Each Party shall exert its best efforts to prepare and submit a proposal that will result in the selection of Prime as prime contractor for the Program and the acceptance of Subcontractor for the work assigned to Subcontractor in Exhibit A. Each Party shall continue such efforts throughout any negotiations concerning a prime contract or subcontract that may follow proposal submission, including furnishing qualified personnel to cooperate in drafting the proposal. Prime shall have sole responsibility for the final content, format, and submission of the proposal and for all communications with the customer.</li>
<li><b>Responsibilities and Scope of Work.</b> Subcontractor shall be responsible for the areas of work described in Exhibit A, which is incorporated into this Agreement by reference. Subcontractor shall provide, at no cost to Prime, technical data, personnel qualifications, past performance information, pricing inputs, and other proposal materials reasonably requested by Prime, in the format and by the deadlines Prime specifies.{{#if proposal_due}} The proposal is due {{proposal_due_long}}, and time is of the essence.{{/if}}</li>
<li><b>Exclusivity.</b> {{#if exclusive}}During the term of this Agreement, each Party shall work exclusively with the other with respect to the Program for the scope of work described in Exhibit A. Neither Party shall participate in the Program, directly or indirectly, on any other team or independently with respect to such scope of work, provided that nothing herein restricts either Party from pursuing other opportunities unrelated to the Program.{{/if}}{{#unless exclusive}}This Agreement is non-exclusive. Each Party may participate in other teams for the Program, provided that it shall not use or disclose the other Party's confidential information in doing so.{{/unless}}</li>
<li><b>Subcontract.</b> If Prime is awarded a prime contract for the Program, Prime shall, promptly after award and subject to customer approval where required, negotiate in good faith with Subcontractor a subcontract for the work described in Exhibit A. The subcontract shall contain terms consistent with the prime contract, including all flow-down provisions required by the prime contract and applicable law. The subcontract shall be subject to agreement on price, schedule, and terms, and to any customer consent requirements.</li>
<li><b>No Obligation and Costs.</b> Each Party shall bear its own costs, expenses, and risks incurred in connection with this Agreement, the proposal effort, and any negotiations, with no right of reimbursement from the other Party. This Agreement does not obligate the customer to issue a solicitation or make an award and does not guarantee award of a prime contract or subcontract.</li>
<li><b>Confidentiality.</b> Each Party may disclose to the other proprietary or confidential information in connection with this Agreement. The receiving Party shall use such information solely for purposes of the Program, shall protect it with at least the same degree of care it uses for its own confidential information and not less than reasonable care, and shall not disclose it to third parties without the disclosing Party's prior written consent. These obligations shall survive termination of this Agreement for {{confidentiality_years}} years and do not apply to information that is or becomes public through no fault of the receiving Party, was rightfully known without restriction, is independently developed, or is required to be disclosed by law, including any applicable public records or freedom of information law, provided the receiving Party gives prompt notice where legally permitted.</li>
<li><b>Independent Contractors.</b> The Parties are independent contractors. This Agreement does not create a partnership, joint venture, agency, or employment relationship, and neither Party may bind the other or incur obligations on the other's behalf.</li>
<li><b>Publicity.</b> Neither Party shall issue any press release or public announcement concerning this Agreement, the proposal, or the Program without the prior written consent of the other Party, except as required by law or regulation.</li>
<li><b>Term and Termination.</b> This Agreement shall terminate upon the earliest of: (a) official cancellation of the Program by the customer; (b) award of the Program to a party other than Prime; (c) execution of a subcontract between the Parties for the Program; (d) Prime's decision not to submit a proposal, with written notice to Subcontractor; (e) mutual written agreement of the Parties; (f) failure of the Parties, despite good faith negotiations, to reach agreement on a subcontract within {{negotiation_days}} days after prime contract award; or (g) {{term_months}} months from the Effective Date if none of the foregoing has occurred. Sections 5, 6, 8, 11, and 12 survive termination.</li>
<li><b>Assignment.</b> Neither Party may assign this Agreement without the prior written consent of the other Party, except to a successor in connection with a merger, acquisition, or sale of substantially all assets, with written notice to the other Party.</li>
<li><b>Governing Law and Disputes.</b> This Agreement shall be governed by and construed in accordance with the laws of {{law_place}}, without regard to its conflict of laws principles. The Parties shall first attempt in good faith to resolve any dispute through negotiation between senior representatives. Exclusive venue for any action arising under this Agreement shall lie in {{venue_place}}.</li>
<li><b>Limitation of Liability.</b> Neither Party shall be liable to the other for any indirect, incidental, consequential, or punitive damages, or for lost profits or anticipated subcontract value, arising out of this Agreement or the failure to receive an award or execute a subcontract.</li>
<li><b>Entire Agreement; Amendment; Counterparts.</b> This Agreement, including Exhibit A, constitutes the entire agreement of the Parties with respect to its subject matter and supersedes all prior understandings. It may be amended only in a writing signed by both Parties. It may be executed in counterparts, including by electronic signature, each of which shall be deemed an original.</li>
<li><b>Notices.</b> Notices shall be in writing and delivered by email with confirmation, or by courier or certified mail, to: (a) for {{prime_short}}: {{prime_contact}}; and (b) for {{sub_short}}: {{sub_contact}}.</li>
</ol>
<p>IN WITNESS WHEREOF, the Parties have caused this Agreement to be executed by their duly authorized representatives as of the Effective Date.</p>
{{signatures}}
<div class="agr-exhibit">
<h2>EXHIBIT A<br><small>Subcontractor Responsibilities and Scope of Work</small></h2>
<p><b>Program:</b> {{program}}</p>
<p>{{sub_name}} shall support the {{prime_name}} team in the following areas, subject to refinement during proposal development:</p>
<ol>{{#each scope_items}}<li>{{.}}</li>{{/each}}</ol>
<p>The final allocation of work, deliverables, level of effort, and pricing shall be set forth in the subcontract negotiated pursuant to Section 4 and shall remain consistent with the proposal as submitted and the prime contract as awarded.</p>
</div>`;

const CONSULTING = `
<h1>CONSULTING AGREEMENT</h1>
{{#if reference}}<p class="agr-ref">Reference: {{reference}}</p>{{/if}}
<p>This Consulting Agreement (this "Agreement") is entered into effective as of {{effective_date_long}} (the "Effective Date") by and between <b>{{company_name}}</b>, {{company_entity}} with its principal office at {{company_address}} (the "Company"), and <b>{{party_name}}</b>{{#if party_entity}}, {{party_entity}}{{/if}}, with its address at {{party_address}} (the "Consultant"). The Company and the Consultant are each a "Party" and together the "Parties."</p>
<h2>RECITALS</h2>
<p>A. The Company requires the services described in Schedule 1 (the "Services").</p>
<p>B. The Consultant represents that it has the skills, training, qualifications and experience necessary to perform the Services.</p>
<p>C. The Consultant agrees to provide the Services to the Company on the terms of this Agreement.</p>
<ol class="agr-sections">
<li><b>Services.</b> The Consultant shall perform the Services and deliver the deliverables described in Schedule 1 (the "Deliverables") diligently, in a professional and workmanlike manner consistent with generally accepted industry standards, in compliance with applicable law, and by the dates set out in Schedule 1. The Company may request changes to the Services in writing; any change that affects fees or schedule takes effect only when both Parties agree to it in writing. The Company may review and reject any Deliverable that does not conform to Schedule 1, in which case the Consultant shall correct it at no additional charge within a reasonable time.</li>
<li><b>Term.</b> This Agreement begins on the Effective Date and continues until {{#if end_date}}{{end_date_long}}{{/if}}{{#unless end_date}}the Services are completed{{/unless}}, unless terminated earlier under Section 11. The Parties may extend the term by written agreement.</li>
<li><b>Fees and Payment.</b> In consideration of the Services, the Company shall pay the Consultant {{fee_text}}{{#if fee_cap}}, provided that total fees under this Agreement shall not exceed {{fee_cap_text}} without the Company's prior written approval{{/if}}. The Consultant shall invoice the Company {{invoice_frequency}}, with each invoice itemizing the Services performed, time spent where fees are time-based, and any approved expenses. The Company shall pay undisputed amounts within {{payment_days}} days of receipt of a correct invoice. The Company shall notify the Consultant of any disputed amount within that period and the Parties shall work in good faith to resolve it.</li>
<li><b>Expenses.</b> {{#if expenses}}The Company shall reimburse reasonable, documented out-of-pocket expenses that the Company has approved in writing in advance, at cost and without markup.{{/if}}{{#unless expenses}}The fees include all of the Consultant's costs and expenses, and the Company shall not reimburse any expenses unless it agrees otherwise in writing.{{/unless}}</li>
<li><b>Consultant's Personnel and Subcontracting.</b> The Consultant shall perform the Services through the personnel named in Schedule 1 (if any) and shall not replace key personnel without the Company's prior written consent, which shall not be unreasonably withheld. The Consultant shall not subcontract any part of the Services without the Company's prior written consent and remains responsible for the acts and omissions of its personnel and any approved subcontractors.</li>
<li><b>Independent Contractor.</b> The Consultant is an independent contractor and not an employee, partner, agent or joint venturer of the Company. The Consultant controls the manner and means of performing the Services, supplies its own equipment unless otherwise agreed, and is solely responsible for its personnel's wages, benefits, insurance, and all taxes, contributions and filings arising from fees paid under this Agreement. Neither the Consultant nor its personnel are eligible for the Company's employee benefits, and the Consultant has no authority to bind the Company.</li>
<li><b>Confidentiality.</b> "Confidential Information" means all non-public information disclosed by or on behalf of the Company, in any form, including business, technical, financial, customer and personnel information and the Deliverables. The Consultant shall use Confidential Information only to perform the Services, protect it with at least reasonable care, disclose it only to its personnel who need to know it and are bound by written obligations at least as protective as these, and return or destroy it on request or at the end of this Agreement. These obligations do not apply to information that is or becomes public through no fault of the Consultant, was lawfully known to the Consultant without restriction, is independently developed without use of Confidential Information, or must be disclosed by law (after prompt notice to the Company where legally permitted). These obligations survive for {{confidentiality_years}} years after this Agreement ends, and for trade secrets for as long as they remain trade secrets.</li>
<li><b>Intellectual Property.</b> {{#if company_owns_ip}}All Deliverables and all intellectual property rights in them that the Consultant creates in performing the Services ("Developed IP") are owned by the Company upon creation. To the extent any Developed IP does not vest in the Company automatically, the Consultant hereby assigns it to the Company, and shall sign any documents reasonably required to confirm or register the Company's ownership. The Consultant retains ownership of its pre-existing materials and know-how ("Background IP"), and grants the Company a non-exclusive, perpetual, irrevocable, royalty-free, worldwide license to use, copy, modify and sublicense any Background IP incorporated into the Deliverables, solely as part of the Deliverables.{{/if}}{{#unless company_owns_ip}}The Consultant retains ownership of the Deliverables and all intellectual property rights in them, and grants the Company a non-exclusive, perpetual, irrevocable, royalty-free, worldwide license to use, copy, modify and sublicense the Deliverables for the Company's business purposes.{{/unless}} The Consultant warrants that the Deliverables and the Company's use of them as contemplated by this Agreement will not infringe the intellectual property rights of any third party, and that the Consultant will not incorporate third-party or open-source materials into the Deliverables without disclosing them to the Company in writing.</li>
<li><b>Warranties.</b> Each Party warrants that it has full power and authority to enter into and perform this Agreement. The Consultant further warrants that it holds, and will maintain, all licenses, registrations and qualifications required to perform the Services; that it is not bound by any agreement that conflicts with this Agreement; and that it will comply with all applicable laws, including anti-bribery, anti-corruption, export control, data protection and labor laws, in performing the Services.</li>
<li><b>Insurance.</b> {{#if insurance}}During the term the Consultant shall maintain, with reputable insurers, commercial general liability insurance of at least {{insurance_gl}} per occurrence and professional liability (errors and omissions) insurance of at least {{insurance_pl}} per claim, together with any workers' compensation insurance required by law, and shall provide certificates of insurance on request.{{/if}}{{#unless insurance}}The Consultant shall maintain any insurance required by law for its business and personnel.{{/unless}}</li>
<li><b>Termination.</b> Either Party may terminate this Agreement for convenience on {{termination_days}} days' written notice. Either Party may terminate immediately on written notice if the other Party materially breaches this Agreement and fails to cure the breach within ten (10) days after notice, or becomes insolvent or subject to bankruptcy, receivership or similar proceedings. On termination, the Company shall pay for Services properly performed and approved expenses incurred up to the termination date, and the Consultant shall promptly deliver all completed and in-progress Deliverables and return all Company property and Confidential Information. Sections 6, 7, 8, 12, 13, 14 and 16 survive termination.</li>
<li><b>Limitation of Liability.</b> Except for breach of Section 7 (Confidentiality), infringement claims under Section 8, a Party's indemnity obligations, or a Party's gross negligence, fraud or willful misconduct, neither Party is liable to the other for any indirect, incidental, special, consequential or punitive damages, or for loss of profits, revenue or data, arising out of this Agreement, and each Party's total liability under this Agreement shall not exceed the total fees paid and payable under this Agreement.</li>
<li><b>Indemnity.</b> The Consultant shall defend, indemnify and hold harmless the Company and its officers, employees and agents from and against third-party claims, losses and reasonable costs (including attorneys' fees) arising from (a) the Consultant's breach of Section 7 or Section 8, (b) the Consultant's negligence or willful misconduct, or (c) any claim that the Consultant or its personnel are employees of the Company or are owed wages, benefits or taxes by the Company.</li>
<li><b>Non-Solicitation.</b> {{#if non_solicit}}During the term and for twelve (12) months afterward, the Consultant shall not, directly or indirectly, solicit any employee or contractor of the Company with whom the Consultant worked under this Agreement to leave the Company, provided that general advertisements not targeted at the Company's personnel are not a breach.{{/if}}{{#unless non_solicit}}Intentionally left blank.{{/unless}}</li>
<li><b>Records and Audit.</b> The Consultant shall keep accurate records of time spent, expenses and Services performed for at least three (3) years after the final payment, and shall make them available to the Company (or a customer of the Company where required by the Company's contract with that customer) on reasonable notice.</li>
<li><b>Governing Law and Disputes.</b> This Agreement is governed by the laws of {{law_place}}, without regard to its conflict of laws principles. The Parties shall first try in good faith to resolve any dispute through discussions between senior representatives for at least fifteen (15) days. Exclusive venue for any action arising out of this Agreement lies in {{venue_place}}, and each Party consents to the jurisdiction of those courts. Either Party may seek injunctive relief in any court of competent jurisdiction to protect its Confidential Information or intellectual property.</li>
<li><b>Notices.</b> Notices must be in writing and delivered by email with confirmation of receipt, by courier, or by certified mail, to: (a) the Company: {{company_contact}}; and (b) the Consultant: {{party_contact}}. A Party may change its notice details by notice to the other.</li>
<li><b>General.</b> This Agreement, including Schedule 1, is the entire agreement between the Parties about its subject matter and supersedes all prior understandings. It may be amended only in a writing signed by both Parties. Neither Party may assign this Agreement without the other's prior written consent, except that the Company may assign it to a successor to all or substantially all of its business. If any provision is held unenforceable, the rest of this Agreement remains in effect and the provision shall be enforced to the maximum extent permitted. A failure or delay in exercising a right is not a waiver. Neither Party is liable for delay caused by events beyond its reasonable control, provided it gives prompt notice and uses reasonable efforts to resume performance.</li>
</ol>
${SIG_NOTE}
<p>IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.</p>
{{signatures}}
<div class="agr-exhibit">
<h2>SCHEDULE 1<br><small>Services, Deliverables and Fees</small></h2>
<table class="agr-table">
<tr><th>Services</th><td>{{services}}</td></tr>
<tr><th>Deliverables and due dates</th><td><ul>{{#each deliverables}}<li>{{.}}</li>{{/each}}</ul></td></tr>
<tr><th>Start date</th><td>{{start_date_long}}</td></tr>
<tr><th>End date</th><td>{{#if end_date}}{{end_date_long}}{{/if}}{{#unless end_date}}On completion of the Services{{/unless}}</td></tr>
<tr><th>Fees</th><td>{{fee_text}}{{#if fee_cap}}; not to exceed {{fee_cap_text}}{{/if}}</td></tr>
<tr><th>Invoicing and payment</th><td>Invoiced {{invoice_frequency}}; payment within {{payment_days}} days</td></tr>
{{#if key_personnel}}<tr><th>Key personnel</th><td>{{key_personnel}}</td></tr>{{/if}}
<tr><th>Company contact</th><td>{{company_signer_name}}{{#if company_signer_email}}, {{company_signer_email}}{{/if}}</td></tr>
</table>
</div>`;

const CIA = `
<h1>{{company_name}}<br>Confidentiality and Assignment Agreement</h1>
<p>In consideration and as a condition of {{relationship_text}} by {{company_name}}, {{company_entity}} (the "Company"), I, <b>{{party_name}}</b>, of {{party_address}}, agree as follows:</p>
<ol class="agr-sections">
<li><b>Proprietary Information.</b> I agree that all information, whether or not in writing, concerning the Company's business, technology, business relationships or financial affairs which the Company has not released to the general public (collectively, "Proprietary Information") is and will be the exclusive property of the Company. By way of illustration, Proprietary Information may include information or material which has not been made generally available to the public, such as: (a) company information, including plans, strategies, methods, policies, resolutions, negotiations or litigation; (b) marketing information, including strategies, methods, customer identities or other information about customers, prospect identities or other information about prospects, or market analyses or projections; (c) financial information, including cost and performance data, debt arrangements, equity structure, investors and holdings, purchasing and sales data and price lists; (d) operational and technological information, including plans, specifications, manuals, forms, templates, software, designs, methods, procedures, formulas, discoveries, inventions, improvements, concepts and ideas; and (e) personnel information, including personnel lists, reporting or organizational structure, resumes, personnel data, compensation structure, performance evaluations and termination arrangements or documents. Proprietary Information also includes information received in confidence by the Company from its customers or suppliers or other third parties.</li>
<li><b>Recognition of Company's Rights.</b> I will not, at any time, without the Company's prior written permission, either during or after my employment or service, disclose any Proprietary Information to anyone outside of the Company, or use or permit to be used any Proprietary Information for any purpose other than the performance of my duties as an employee, advisor or consultant of the Company. I will cooperate with the Company and use my best efforts to prevent the unauthorized disclosure of all Proprietary Information. I will deliver to the Company all copies of Proprietary Information in my possession or control upon the earlier of a request by the Company or termination of my employment or service. I will not, under any circumstances, (a) remove any source code of the Company from the premises of the Company or (b) remotely access any source code of the Company except as the Company authorizes.</li>
<li><b>Rights of Others.</b> I understand that the Company is now and may hereafter be subject to non-disclosure or confidentiality agreements with third persons which require the Company to protect or refrain from use of Proprietary Information. I agree to be bound by the terms of such agreements in the event I have access to such Proprietary Information.</li>
<li><b>Commitment to Company; Avoidance of Conflict of Interest.</b> While an employee, advisor or consultant of the Company, I will not engage in any other business activity that directly conflicts with my duties to the Company. I will advise the Chief Executive Officer of the Company or his or her nominee at such time as any activity of either the Company or another business presents me with a conflict of interest or the appearance of a conflict of interest. I will take whatever action is requested of me by the Company to resolve any conflict or appearance of conflict which it finds to exist.</li>
<li><b>Developments.</b> I will make full and prompt disclosure to the Company of all inventions, discoveries, designs, developments, methods, modifications, improvements, processes, algorithms, databases, computer programs, formulae, techniques, trade secrets, ideas, concepts, methodologies, graphics or images, and audio or visual works and other works of authorship (collectively "Developments"), whether or not patentable or copyrightable, that are created, made, conceived or reduced to practice by me (alone or jointly with others) or under my direction during the period of my employment, advisory or consulting relationship. I acknowledge that all work performed by me is on a "work for hire" basis to the extent permitted by law, and I hereby do assign and transfer and, to the extent any such assignment cannot be made at present, will assign and transfer, to the Company and its successors and assigns all my right, title and interest in all Developments that (a) relate to the business of the Company or any of the products or services being researched, developed, manufactured or sold by the Company or which may be used with such products or services; or (b) result from tasks assigned to me by the Company; or (c) result from the use of premises or personal property (whether tangible or intangible) owned, leased or contracted for by the Company ("Company-Related Developments"), and all related patents, patent applications, trademarks and trademark applications, copyrights and copyright applications, and other intellectual property rights in all countries and territories worldwide and under any international conventions ("Intellectual Property Rights").
<p>To preclude any possible uncertainty, I have set forth on Exhibit A a complete list of Developments that I have, alone or jointly with others, conceived, developed or reduced to practice prior to the commencement of my employment or service with the Company that I consider to be my property or the property of third parties and that I wish to have excluded from the scope of this Agreement ("Prior Inventions"). If disclosure of any such Prior Invention would cause me to violate any prior confidentiality agreement, I will not list such Prior Inventions in Exhibit A but will only disclose a cursory name for each such invention, a listing of the party(ies) to whom it belongs and the fact that full disclosure has not been made for that reason. I have also listed on Exhibit A all patents and patent applications in which I am named as an inventor, other than those which have been assigned to the Company ("Other Patent Rights"). If no such disclosure is listed, I represent that there are no Prior Inventions or Other Patent Rights. If I incorporate a Prior Invention into a Company product, process or machine or other work done for the Company, I hereby grant to the Company a nonexclusive, royalty-free, paid-up, irrevocable, worldwide license (with the full right to sublicense) to make, have made, modify, use, sell, offer for sale and import such Prior Invention. I will not incorporate, or permit to be incorporated, Prior Inventions in any Company-Related Development without the Company's prior written consent.</p>
<p>This Agreement does not obligate me to assign to the Company any Development which is developed entirely on my own time, does not relate to the business or research and development in which the Company actually is engaged or reasonably would be engaged, and does not result from the use of premises or equipment owned or leased by the Company. I will promptly disclose any such Developments to the Company for the purpose of determining whether they qualify for this exclusion. To the extent this Agreement is required to be construed in accordance with the laws of any jurisdiction which precludes a requirement to assign certain classes of inventions, this Section 5 will be interpreted not to apply to any invention which a court rules and/or the Company agrees falls within such classes. I also hereby waive, to the extent permitted by law, all claims to any moral rights or other special rights which I may have or accrue in any Company-Related Developments.</p></li>
<li><b>Documents and Other Materials.</b> I will keep and maintain adequate and current records of all Proprietary Information and Company-Related Developments developed by me during my employment or service, which records will be available to and remain the sole property of the Company at all times. All files, letters, notes, memoranda, reports, records, data, sketches, drawings, notebooks, layouts, charts, quotations and proposals, specification sheets, program listings, blueprints, models, prototypes, or other written, photographic or other tangible material containing Proprietary Information, whether created by me or others, which come into my custody or possession, are the exclusive property of the Company to be used by me only in the performance of my duties for the Company. Any property situated on the Company's premises and owned by the Company, including computers, disks and other storage media, filing cabinets or other work areas, is subject to inspection by the Company at any time with or without notice. In the event of the termination of my employment, advisory relationship or consultancy for any reason, I will deliver to the Company all such materials pertaining to the Proprietary Information of the Company and to my work, and will not take or keep in my possession any of the foregoing or any copies.</li>
<li><b>Enforcement of Intellectual Property Rights.</b> I will cooperate fully with the Company, both during and after my employment or service, with respect to the procurement, maintenance and enforcement of Intellectual Property Rights in Company-Related Developments. I will sign, both during and after the term of this Agreement, all papers, including copyright applications, patent applications, declarations, oaths, assignments of priority rights, and powers of attorney, which the Company may deem necessary or desirable in order to protect its rights and interests in any Company-Related Development. If the Company is unable, after reasonable effort, to secure my signature on any such papers, I hereby irrevocably designate and appoint each officer of the Company as my agent and attorney-in-fact to execute any such papers on my behalf, and to take any and all actions as the Company may deem necessary or desirable in order to protect its rights and interests in any Company-Related Development.</li>
<li><b>Non-Solicitation{{#if noncompete}}; Non-Competition{{/if}}; Non-Disparagement.</b> During the Restricted Period (as defined below), I will not, directly or indirectly, in any manner, other than for the benefit of the Company, (a) call upon, solicit, divert or take away any of the customers, business or prospective customers of the Company or any of its suppliers, or request or cause any of them to cancel or terminate any part of their relationship with the Company or refuse to enter into any business relationship with the Company{{#if noncompete}}, (b) solicit, entice or attempt to persuade any other employee, agent or consultant of the Company to leave the services of the Company for any reason, or assist in such hiring or engagement by another person or business entity, and/or (c) own, operate, manage, control, engage in, participate in, invest in, permit my name to be used by, act as a consultant or advisor to, render services for, or otherwise assist any person or entity that engages in or owns, invests in, operates, manages or controls any venture or enterprise which, directly or indirectly, competes with the Company{{/if}}{{#unless noncompete}}, or (b) solicit, entice or attempt to persuade any other employee, agent or consultant of the Company to leave the services of the Company for any reason, or assist in such hiring or engagement by another person or business entity{{/unless}}. If I violate this Section 8, the Restricted Period will be extended by the time during which I engage in such violation(s), to the extent permitted by law. "Restricted Period" means the period during which I am employed by or providing advisory or consulting services to the Company and a period of {{restricted_months}} months immediately following the end of that relationship.
<p>I agree that I shall not, directly or indirectly, at any time following the date hereof, disparage the Company or its business, customers, prospective customers, products or services, nor will I interfere with the Company's relationships with its customers, prospective customers, employees, consultants, vendors, bankers, or any other person or entity with whom the Company has an established or prospective business relationship. Nothing in this Agreement prevents me from testifying truthfully, communicating with any government agency, or making disclosures protected by law.</p></li>
<li><b>Government Contracts.</b> I acknowledge that the Company may have from time to time agreements with other persons or with governments or their agencies which impose obligations or restrictions on the Company regarding inventions made during the course of work under such agreements or regarding the confidential nature of such work. I agree to comply with any such obligations or restrictions upon the direction of the Company. In addition to the rights assigned under Section 5, I also assign to the Company (or any of its nominees) all rights which I have or acquire in any Developments, full title to which is required to be in a government under any contract between the Company and that government or any of its agencies.</li>
<li><b>Prior Agreements.</b> I represent that, except as I have fully disclosed previously in writing to the Company, I am not bound by the terms of any agreement with any previous employer or other party to refrain from using or disclosing any trade secret or confidential or proprietary information in the course of my employment or service with the Company or to refrain from competing, directly or indirectly, with the business of such previous employer or any other party. I further represent that my performance of all the terms of this Agreement does not and will not breach any agreement to keep in confidence proprietary information, knowledge or data acquired by me in confidence or in trust prior to my employment or service with the Company. I will not disclose to the Company or induce the Company to use any confidential or proprietary information or material belonging to any previous employer or others.</li>
<li><b>Remedies Upon Breach.</b> I understand that the restrictions contained in this Agreement are necessary for the protection of the business and goodwill of the Company and I consider them to be reasonable for such purpose. Any breach of this Agreement is likely to cause the Company substantial and irrevocable damage and therefore, in the event of such breach, the Company, in addition to such other remedies which may be available, will be entitled to specific performance and injunctive relief without the necessity of proving actual damages.</li>
<li><b>Use of Voice, Image and Likeness.</b> {{#if likeness}}I give the Company permission to use my voice, image or likeness, with or without using my name, for the purposes of advertising and promoting the Company, or for other purposes deemed appropriate by the Company in its reasonable discretion, except to the extent expressly prohibited by law.{{/if}}{{#unless likeness}}The Company will not use my voice, image or likeness for advertising without my separate written consent.{{/unless}}</li>
<li><b>Publications and Public Statements.</b> I will obtain the Company's written approval before publishing or submitting for publication any material that relates to my work at the Company and/or incorporates any Proprietary Information. Any statement about the Company which I create, publish or post during my period of employment, advisory relationship or consultancy and for {{publication_months}} months thereafter, on any media accessible by the public, must first be reviewed and approved by an officer of the Company before it is released in the public domain.</li>
<li><b>No Employment Obligation.</b> I understand that this Agreement does not create an obligation on the Company or any other person to continue my employment or service relationship. Unless otherwise agreed in a formal written employment, advisory or consulting agreement signed on behalf of the Company by an authorized officer (other than myself), my employment, advisory or consulting relationship with the Company is at will and may be terminated by the Company or me at any time and for any reason, to the extent permitted by law.</li>
<li><b>Survival and Assignment by the Company.</b> My obligations under this Agreement will continue in accordance with its express terms regardless of any changes in my title, position, duties, salary, compensation or benefits or other terms and conditions of employment or service, and will continue following the termination of my employment, advisory or consulting relationship regardless of the manner of such termination, and will be binding upon my heirs, executors and administrators. The Company will have the right to assign this Agreement to its affiliates, successors and assigns. I consent to be bound by this Agreement for the benefit of the Company or any parent, subsidiary or affiliate to whose employ or service I may be transferred without the necessity that this Agreement be re-signed at the time of such transfer.</li>
<li><b>Disclosure to Future Employers.</b> I will provide a copy of the restrictive provisions of this Agreement to any prospective employer, partner or co-venturer prior to entering into an employment, partnership or other business relationship with such person or entity.</li>
<li><b>Severability.</b> In case any provision (or portion thereof) of this Agreement shall, for any reason, be held invalid, illegal or unenforceable in any respect, such invalidity, illegality or unenforceability shall not affect the other provisions of this Agreement, and this Agreement shall be construed as if such provision had never been contained herein. If any provision shall for any reason be held to be excessively broad as to duration, geographical scope, activity or subject, it shall be construed by limiting and reducing it, so as to be enforceable to the extent compatible with the applicable law as it shall then appear.</li>
<li><b>Whistleblower and Trade Secret Notice.</b> Nothing in this Agreement prohibits me from reporting possible violations of law to any governmental authority or from making other disclosures protected by whistleblower laws. {{#if us_law}}Pursuant to the Defend Trade Secrets Act, 18 U.S.C. § 1833(b), I shall not be held criminally or civilly liable under any federal or state trade secret law for the disclosure of a trade secret that (a) is made (i) in confidence to a federal, state, or local government official, either directly or indirectly, or to an attorney, and (ii) solely for the purpose of reporting or investigating a suspected violation of law, or (b) is made in a complaint or other document filed in a lawsuit or other proceeding, if such filing is made under seal. If I file a lawsuit for retaliation by the Company for reporting a suspected violation of law, I may disclose the trade secret to my attorney and use the trade secret information in the court proceeding if I file any document containing the trade secret under seal and do not disclose the trade secret except pursuant to court order.{{/if}}</li>
<li><b>Interpretation.</b> This Agreement will be deemed to be made and entered into in {{law_place}}, and will in all respects be interpreted, enforced and governed under the laws of {{law_place}}. I consent to personal jurisdiction of {{venue_place}} for purposes of enforcing this Agreement, and waive any objection that I might have to personal jurisdiction or venue in those courts. This Agreement contains the full and complete understanding of the parties with respect to the subject matter hereof and supersedes all prior representations and understandings, whether oral or written.</li>
</ol>
<p><b>I UNDERSTAND THAT THIS AGREEMENT AFFECTS IMPORTANT RIGHTS. BY SIGNING BELOW, I CERTIFY THAT I HAVE READ IT CAREFULLY AND AM SATISFIED THAT I UNDERSTAND IT COMPLETELY.</b></p>
<p>IN WITNESS WHEREOF, the undersigned has executed this Agreement as of the date of signature below.</p>
{{signatures}}
<div class="agr-exhibit">
<h2>EXHIBIT A<br><small>Prior Inventions</small></h2>
<p>To: {{company_name}} &nbsp;·&nbsp; From: {{party_name}}</p>
<p>The following is a complete list of all inventions or improvements relevant to the subject matter of my employment by or advisory or consulting relationship with the Company that have been made or conceived or first reduced to practice by me alone or jointly with others prior to my engagement by the Company:</p>
<p class="agr-box">{{#if prior_inventions}}{{prior_inventions}}{{/if}}{{#unless prior_inventions}}None.{{/unless}}</p>
<p>The following is a list of all patents and patent applications in which I have been named as an inventor:</p>
<p class="agr-box">{{#if prior_patents}}{{prior_patents}}{{/if}}{{#unless prior_patents}}None.{{/unless}}</p>
</div>`;


const EMPLOYMENT = `
<h1>EMPLOYMENT AGREEMENT</h1>
<p>This Employment Agreement (this "Agreement") is made effective as of {{effective_date_long}} between <b>{{company_name}}</b>{{#if company_entity}}, {{company_entity}}{{/if}} (the "Company"), and <b>{{party_name}}</b>, of {{party_address}} ("you").</p>
<ol class="agr-sections">
<li><b>Position.</b> The Company employs you as <b>{{position_title}}</b>{{#if manager_title}}, reporting to the {{manager_title}}{{/if}}, starting on {{start_date_long}}. This is a {{employment_type_text}} position classified as <b>{{classification}}</b> under the Fair Labor Standards Act and applicable state law. You will work {{work_location}}. You will perform the duties the Company reasonably assigns and devote your working time and best efforts to the Company.</li>
<li><b>Pay.</b> The Company will pay you {{pay_text}}, less applicable withholdings and deductions, on the Company's regular pay schedule ({{pay_frequency}}).{{#if classification_nonexempt}} You will be paid for all hours worked, including overtime as the law requires; overtime must be approved in advance.{{/if}} The Company reviews pay periodically and may adjust it.</li>
{{#if bonus}}<li><b>Bonus.</b> {{bonus}} Any bonus is at the Company's discretion unless this section states otherwise.</li>{{/if}}
<li><b>Benefits and time off.</b> You may take part in the benefit plans the Company offers to similarly situated employees, under the terms of those plans, which the Company may change. {{#if benefits}}{{benefits}} {{/if}}{{#if pto_days}}You will receive {{pto_days}} days of paid time off a year, plus Company holidays, under the Company's time off policy.{{/if}}</li>
{{#if probation_days}}<li><b>Introductory period.</b> The first {{probation_days}} days of employment are an introductory period to review fit and performance. Completing it does not change the at-will nature of employment.</li>{{/if}}
<li><b>Company policies.</b> You agree to follow the Company's policies, as published in Pulse and updated from time to time, and to read and certify them when asked. If a policy conflicts with this Agreement, this Agreement controls.</li>
<li><b>Confidentiality and inventions.</b> As a condition of employment you will sign, and comply with, the Company's Confidentiality and Assignment Agreement, which protects the Company's confidential information and assigns to the Company the work product you create in your employment.</li>
<li><b>Other work.</b> While employed, you will not work for or advise a competitor, customer or supplier of the Company without the Company's written consent, and you will tell the Company about any outside activity that could create a conflict of interest.</li>
{{#if us_law}}<li><b>Employment eligibility.</b> This offer depends on your providing proof of your identity and authorization to work in the United States (Form I-9) within three business days of your start date{{#if background_check}}, and on satisfactory completion of a background check as permitted by law{{/if}}.</li>{{/if}}
<li><b>At-will employment.</b> {{#if us_law}}Your employment is at will: you or the Company may end it at any time, for any lawful reason, with or without cause or notice.{{/if}}{{#unless us_law}}Either party may end your employment by giving {{notice_days}} days' written notice, or as the law of the place where you work requires if longer. The Company may pay salary in place of notice.{{/unless}} {{#if us_law}}We ask that you give {{notice_days}} days' notice if you resign.{{/if}} On leaving you will return all Company property and information.</li>
{{#if arbitration}}<li><b>Dispute resolution.</b> You and the Company agree to resolve disputes under the Company's separate Arbitration Agreement, which you will sign with this Agreement.</li>{{/if}}
<li><b>Entire agreement.</b> This Agreement, with the Confidentiality and Assignment Agreement{{#if arbitration}} and the Arbitration Agreement{{/if}}, is the entire agreement about your employment and replaces any earlier offer or discussion. It may be changed only in a writing signed by you and an officer of the Company. It is governed by the laws of {{law_place}}. If any part is unenforceable, the rest remains in effect. Electronic signatures count as originals.</li>
</ol>
{{signatures}}`;

const AMENDMENT = `
<h1>AMENDMENT NO. {{amendment_no}}<br><small>to the {{original_title}}</small></h1>
<p>This Amendment No. {{amendment_no}} (this "Amendment") is made effective as of {{effective_date_long}} by and between <b>{{company_name}}</b>{{#if company_entity}}, {{company_entity}}{{/if}} (the "Company"), and <b>{{party_name}}</b>{{#if party_entity}}, {{party_entity}}{{/if}} (the "Counterparty"), and amends the {{original_title}} between them dated {{original_date_long}} (reference {{original_ref}}) (the "Agreement").</p>
<p>The Parties agree to amend the Agreement as follows:</p>
<ol class="agr-sections"></ol>
<p>Except as expressly amended by this Amendment, all terms of the Agreement remain unchanged and in full force and effect. If this Amendment conflicts with the Agreement, this Amendment controls. Capitalized terms not defined in this Amendment have the meanings given in the Agreement. This Amendment is governed by the same law as the Agreement and may be executed in counterparts and by electronic signature.</p>
{{signatures}}`;

const BUILTIN_TEMPLATES = [
  { key: "teaming", kind: "teaming", name: "Teaming Agreement", icon: "team",
    blurb: "Pursue a solicitation together: prime and subcontractor roles, exclusivity, confidentiality, scope in Exhibit A.",
    checklist: [], signers: [{ role: "company", label: "Your company" }, { role: "party", label: "Teaming partner" }],
    fields: [
      { key: "our_role", label: "Your company is the", group: "The opportunity", type: "select", options: ["Prime", "Subcontractor"], default: "Prime" },
      { key: "program", label: "Program (customer, solicitation number, title)", group: "The opportunity", required: true, placeholder: "Commonwealth of Virginia, VITA, RFP 2026-01, Water Monitoring Solutions" },
      { key: "proposal_due", label: "Proposal due", group: "The opportunity", type: "date" },
      { key: "exclusive", label: "Exclusive for this scope", group: "The opportunity", type: "yesno", default: "yes" },
      { key: "scope_items", label: "Subcontractor scope (Exhibit A), one item per line", group: "The opportunity", type: "lines", required: true },
      { key: "effective_date", label: "Effective date", group: "Terms", type: "date", required: true, default: "today" },
      { key: "confidentiality_years", label: "Confidentiality lasts (years)", group: "Terms", type: "number", default: "3" },
      { key: "negotiation_days", label: "Days to agree a subcontract after award", group: "Terms", type: "number", default: "90" },
      { key: "term_months", label: "Expires after (months)", group: "Terms", type: "number", default: "12" },
      ...F_COMPANY, ...F_PARTY("Teaming partner"), ...F_LAW,
    ], body: TEAMING },
  { key: "consulting", kind: "consulting", name: "Consulting Agreement", icon: "briefcase",
    blurb: "Engage a consultant or contractor: services and deliverables, fees, IP, confidentiality, insurance, termination.",
    checklist: ["sign", "agreement"], signers: [{ role: "company", label: "Your company" }, { role: "party", label: "Consultant" }],
    fields: [
      { key: "reference", label: "Reference / PO number", group: "Engagement" },
      { key: "services", label: "Services (what they'll do)", group: "Engagement", type: "text", required: true },
      { key: "deliverables", label: "Deliverables and due dates, one per line", group: "Engagement", type: "lines", required: true },
      { key: "key_personnel", label: "Key personnel (optional)", group: "Engagement" },
      { key: "effective_date", label: "Effective date", group: "Engagement", type: "date", required: true, default: "today" },
      { key: "start_date", label: "Start date", group: "Engagement", type: "date", required: true, default: "today" },
      { key: "end_date", label: "End date (blank = when services are done)", group: "Engagement", type: "date" },
      { key: "fee_type", label: "Fee basis", group: "Fees", type: "select", options: ["Hourly", "Daily", "Monthly retainer", "Fixed fee"], default: "Hourly" },
      { key: "fee_rate", label: "Rate or fixed amount", group: "Fees", type: "number", required: true },
      { key: "currency", label: "Currency", group: "Fees", type: "select", options: ["USD", "EUR", "GBP", "CAD", "AUD", "KES", "ZAR", "NGN", "INR"], default: "USD" },
      { key: "fee_cap", label: "Not-to-exceed amount (optional)", group: "Fees", type: "number" },
      { key: "invoice_frequency", label: "Invoices", group: "Fees", type: "select", options: ["monthly", "every two weeks", "on completion of each deliverable", "on completion of the Services"], default: "monthly" },
      { key: "payment_days", label: "Pay within (days)", group: "Fees", type: "number", default: "30" },
      { key: "expenses", label: "Reimburse pre-approved expenses", group: "Fees", type: "yesno", default: "yes" },
      { key: "company_owns_ip", label: "Company owns the work product", group: "Terms", type: "yesno", default: "yes" },
      { key: "confidentiality_years", label: "Confidentiality lasts (years)", group: "Terms", type: "number", default: "5" },
      { key: "termination_days", label: "Notice to end for convenience (days)", group: "Terms", type: "number", default: "15" },
      { key: "non_solicit", label: "No soliciting our staff for 12 months", group: "Terms", type: "yesno", default: "yes" },
      { key: "insurance", label: "Require insurance", group: "Terms", type: "yesno", default: "no" },
      { key: "insurance_gl", label: "General liability, per occurrence", group: "Terms", default: "$1,000,000", showIf: "insurance" },
      { key: "insurance_pl", label: "Professional liability, per claim", group: "Terms", default: "$1,000,000", showIf: "insurance" },
      ...F_COMPANY, ...F_PARTY("Consultant"), ...F_LAW,
    ], body: CONSULTING },
  { key: "confidentiality", kind: "confidentiality", name: "Confidentiality and Assignment Agreement", icon: "key",
    blurb: "Protect confidential information and assign work product to the company. For employees, advisors and consultants.",
    checklist: ["nda"], signers: [{ role: "party", label: "Employee / advisor / consultant" }, { role: "company", label: "Your company (acknowledges)" }],
    fields: [
      { key: "relationship", label: "Relationship", group: "The person", type: "select", options: ["Consultant", "Advisor", "Employee", "Contractor"], default: "Consultant" },
      { key: "party_name", label: "Full name", group: "The person", required: true },
      { key: "party_address", label: "Address", group: "The person", required: true },
      { key: "party_signer_email", label: "Email (gets the signing link)", group: "The person", type: "email", required: true },
      { key: "effective_date", label: "Effective date", group: "Terms", type: "date", required: true, default: "today" },
      { key: "noncompete", label: "Include a non-compete", group: "Terms", type: "yesno", default: "yes", warn: "noncompete" },
      { key: "restricted_months", label: "Restricted period after leaving (months)", group: "Terms", type: "number", default: "12" },
      { key: "publication_months", label: "Public statements reviewed for (months after leaving)", group: "Terms", type: "number", default: "6" },
      { key: "likeness", label: "Company may use voice, image and likeness", group: "Terms", type: "yesno", default: "yes" },
      { key: "prior_inventions", label: "Prior inventions (Exhibit A), or leave blank for none", group: "Exhibit A", type: "text" },
      { key: "prior_patents", label: "Patents and applications naming them", group: "Exhibit A", type: "text" },
      ...F_COMPANY, ...F_LAW,
    ], body: CIA },
  { key: "employment", kind: "employment", name: "Employment Agreement", icon: "user-plus",
    blurb: "Hire an employee: position, pay, benefits, time off, policies, confidentiality, at-will terms. The employee signs online.",
    checklist: ["sign", "agreement"], signers: [{ role: "company", label: "Your company" }, { role: "party", label: "Employee" }],
    fields: [
      { key: "party_name", label: "Employee full name", group: "The employee", required: true },
      { key: "party_address", label: "Home address", group: "The employee", required: true },
      { key: "party_signer_email", label: "Email (gets the signing link)", group: "The employee", type: "email", required: true },
      { key: "position_title", label: "Job title", group: "The job", required: true },
      { key: "manager_title", label: "Reports to (title)", group: "The job", placeholder: "Chief Executive Officer" },
      { key: "start_date", label: "Start date", group: "The job", type: "date", required: true },
      { key: "employment_type", label: "Schedule", group: "The job", type: "select", options: ["Full-time", "Part-time"], default: "Full-time" },
      { key: "classification", label: "Overtime classification", group: "The job", type: "select", options: ["Exempt", "Non-exempt"], default: "Exempt" },
      { key: "work_location", label: "Where they work", group: "The job", default: "remotely, with travel as needed", placeholder: "at the Company's office in Alexandria, Virginia" },
      { key: "pay_basis", label: "Pay basis", group: "Pay", type: "select", options: ["Annual salary", "Hourly"], default: "Annual salary" },
      { key: "pay_rate", label: "Amount", group: "Pay", type: "number", required: true },
      { key: "currency", label: "Currency", group: "Pay", type: "select", options: ["USD", "EUR", "GBP", "CAD", "AUD", "KES", "ZAR", "NGN", "INR", "PKR"], default: "USD" },
      { key: "pay_frequency", label: "Paid", group: "Pay", type: "select", options: ["every two weeks", "twice a month", "monthly", "weekly"], default: "twice a month" },
      { key: "bonus", label: "Bonus (optional)", group: "Pay", type: "text" },
      { key: "benefits", label: "Benefits to mention (optional)", group: "Benefits", type: "text", placeholder: "You will be eligible for health insurance on the first of the month after your start date." },
      { key: "pto_days", label: "Paid time off (days a year)", group: "Benefits", type: "number", default: "15" },
      { key: "probation_days", label: "Introductory period (days, blank for none)", group: "Terms", type: "number", default: "90" },
      { key: "notice_days", label: "Notice asked for when resigning (days)", group: "Terms", type: "number", default: "14" },
      { key: "background_check", label: "Subject to a background check", group: "Terms", type: "yesno", default: "no" },
      { key: "arbitration", label: "Disputes go to arbitration (separate agreement)", group: "Terms", type: "yesno", default: "no" },
      { key: "effective_date", label: "Agreement date", group: "Terms", type: "date", required: true, default: "today" },
      ...F_COMPANY, ...F_LAW,
    ], body: EMPLOYMENT },
  { key: "amendment", kind: "amendment", name: "Amendment", icon: "clipboard", amendment: true,
    blurb: "Change an executed agreement: each change is a numbered section. Opens from the agreement you're amending.",
    checklist: [], signers: [{ role: "company", label: "Your company" }, { role: "party", label: "Counterparty" }],
    fields: [
      { key: "amendment_no", label: "Amendment number", group: "Amendment", type: "number", required: true, default: "1" },
      { key: "original_title", label: "Agreement being amended", group: "Amendment", required: true },
      { key: "original_ref", label: "Its reference", group: "Amendment", required: true },
      { key: "original_date", label: "Its date", group: "Amendment", type: "date", required: true },
      { key: "effective_date", label: "Amendment effective date", group: "Amendment", type: "date", required: true, default: "today" },
      ...F_COMPANY, ...F_PARTY("Counterparty"),
    ], body: AMENDMENT },
];

/* ---------------------------------------------------------------- rendering */
const _esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const longDate = (iso) => iso ? new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";
const truthy = (v) => v != null && v !== "" && v !== "no" && v !== false && !(Array.isArray(v) && !v.length);
const lines = (v) => String(v || "").split("\n").map((s) => s.trim()).filter(Boolean);
function moneyText(n, cur) {
  if (n === "" || n == null || isNaN(+n)) return "";
  const sym = { USD: "$", EUR: "€", GBP: "£", CAD: "CA$", AUD: "A$" }[cur];
  const num = (+n).toLocaleString("en-US", { minimumFractionDigits: +n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return sym ? `${sym}${num}` : `${cur || ""} ${num}`.trim();
}
// Everything the template text can use: the form values plus wording worked out from them.
function agreementVars(tpl, v) {
  const x = { ...v };
  x.effective_date_long = longDate(v.effective_date); x.original_date_long = longDate(v.original_date); x.proposal_due_long = longDate(v.proposal_due);
  x.start_date_long = longDate(v.start_date); x.end_date_long = longDate(v.end_date);
  x.law_place = lawPlace(v.law_country, v.law_region); x.venue_place = venuePlace(v.law_country, v.law_region);
  x.us_law = v.law_country === "United States" ? "yes" : "";
  const short = (n) => String(n || "").replace(/,?\s+(Inc\.?|LLC|L\.L\.C\.|Ltd\.?|Limited|Corp\.?|Corporation|Pty Ltd|PLC|GmbH|LLP)$/i, "").trim();
  const contact = (name, title, org, addr, email, phone) => [name && title ? `${name}, ${title}` : name, org, addr, email, phone].filter(Boolean).join(", ");
  x.company_contact = contact(v.company_signer_name, v.company_signer_title, v.company_name, v.company_address, v.company_signer_email);
  x.party_contact = contact(v.party_signer_name, v.party_signer_title, v.party_name, v.party_address, v.party_signer_email, v.party_signer_phone);
  const us = { name: v.company_name, entity: v.company_entity || "a company", address: v.company_address, short: short(v.company_name), contact: x.company_contact };
  const them = { name: v.party_name, entity: v.party_entity || "a company", address: v.party_address, short: short(v.party_name), contact: x.party_contact };
  const [prime, sub] = v.our_role === "Subcontractor" ? [them, us] : [us, them];
  for (const [k, p] of [["prime", prime], ["sub", sub]]) for (const f of ["name", "entity", "address", "short", "contact"]) x[`${k}_${f}`] = p[f];
  const unit = { Hourly: " per hour", Daily: " per day", "Monthly retainer": " per month", "Fixed fee": "" }[v.fee_type] ?? "";
  x.fee_text = v.fee_rate ? (v.fee_type === "Fixed fee" ? `a fixed fee of ${moneyText(v.fee_rate, v.currency)}` : `${moneyText(v.fee_rate, v.currency)}${unit}`) : "";
  x.fee_cap_text = moneyText(v.fee_cap, v.currency);
  x.pay_text = v.pay_rate ? (v.pay_basis === "Hourly" ? `${moneyText(v.pay_rate, v.currency)} per hour` : `an annual salary of ${moneyText(v.pay_rate, v.currency)}`) : "";
  x.employment_type_text = String(v.employment_type || "full-time").toLowerCase();
  x.classification_nonexempt = v.classification === "Non-exempt" ? "yes" : "";
  x.relationship_text = { Employee: "my employment or continued employment", Advisor: "my retention as an advisor or continued retention as an advisor",
    Consultant: "my retention as a consultant or continued retention as a consultant", Contractor: "my engagement as a contractor or continued engagement" }[v.relationship] || "my retention";
  return x;
}
function renderTemplate(body, vars, signaturesHtml = "") {
  let s = String(body);
  const extra = (vars.special_provisions || []).filter((p) => p && (p.title || p.text));
  if (extra.length) {   // extra numbered sections go at the end of the main section list
    const items = extra.map((p) => `<li class="agr-special"><b>${_esc(p.title || "Special Provision")}.</b> ${_esc(p.text || "").replace(/\n/g, "<br>")}</li>`).join("");
    const i = s.indexOf('class="agr-sections"');
    if (i >= 0) { const close = s.indexOf("</ol>", i); s = s.slice(0, close) + items + s.slice(close); }
    else s = s.replace("{{signatures}}", `<h2>SPECIAL PROVISIONS</h2><ol class="agr-sections">${items}</ol>{{signatures}}`);
  }
  s = s.replace(/\{\{#each (\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_, k, inner) => lines(vars[k]).map((item) => inner.replace(/\{\{\.\}\}/g, _esc(item))).join(""));
  for (let i = 0; i < 3; i++) {   // nested ifs, inside out
    s = s.replace(/\{\{#if (\w+)\}\}((?:(?!\{\{#if )[\s\S])*?)\{\{\/if\}\}/g, (_, k, inner) => (truthy(vars[k]) ? inner : ""));
    s = s.replace(/\{\{#unless (\w+)\}\}((?:(?!\{\{#unless )[\s\S])*?)\{\{\/unless\}\}/g, (_, k, inner) => (truthy(vars[k]) ? "" : inner));
  }
  s = s.replace(/\{\{signatures\}\}/g, signaturesHtml);
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] == null || vars[k] === "" ? `<span class="agr-blank">[${_esc(k.replace(/_/g, " "))}]</span>` : _esc(vars[k]).replace(/\n/g, "<br>")));
}
// Signature blocks; signed blocks show the signature, unsigned ones a line (filled in when executed)
function signatureBlocks(tpl, vars, signers = []) {
  const who = (role) => role === "company"
    ? { org: vars.company_name, name: vars.company_signer_name, title: vars.company_signer_title }
    : { org: ["confidentiality", "employment"].includes(tpl.kind) ? "" : vars.party_name, name: vars.party_signer_name || vars.party_name, title: tpl.kind === "confidentiality" ? vars.relationship : tpl.kind === "employment" ? vars.position_title : vars.party_signer_title };
  return `<!--sigs--><div class="agr-sigs">${tpl.signers.map((s) => {
    const p = who(s.role), done = signers.find((x) => x.role === s.role && x.status === "Signed");
    const label = tpl.kind === "teaming" ? ((s.role === "company") === (vars.our_role !== "Subcontractor") ? "PRIME" : "SUBCONTRACTOR") : s.role === "company" ? "COMPANY" : (tpl.kind === "consulting" ? "CONSULTANT" : tpl.kind === "employment" ? "EMPLOYEE" : "SIGNATORY");
    return `<div class="agr-sig"><div class="agr-sig-role">${label}${p.org ? `<br><b>${_esc(String(p.org).toUpperCase())}</b>` : ""}</div>
      <div class="agr-sig-line">${done ? (done.signature_kind === "drawn" && /^data:image\/png;base64,/.test(done.signature_data || "") ? `<img src="${done.signature_data}" alt="Signature">` : `<span class="agr-typed">${_esc(done.signature_data)}</span>`) : ""}</div>
      <div>By: ${done ? "/s/ " + _esc(done.name) : "_______________________________"}</div><div>Name: ${_esc(done?.name || p.name || "")}</div>
      ${p.title || done?.title ? `<div>Title: ${_esc(done?.title || p.title || "")}</div>` : ""}<div>Date: ${done ? _esc(new Date(done.signed_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })) : "__________________"}</div></div>`;
  }).join("")}</div><!--/sigs-->`;
}
const COMPUTED = new Set(["pay_text", "employment_type_text", "classification_nonexempt", "effective_date_long", "proposal_due_long", "start_date_long", "end_date_long", "original_date_long", "law_place", "venue_place", "us_law",
  "company_contact", "party_contact", "fee_text", "fee_cap_text", "relationship_text", "signatures", ...["prime", "sub"].flatMap((k) => ["name", "entity", "address", "short", "contact"].map((f) => `${k}_${f}`))]);
function templateFields(tpl) {
  const known = new Set(tpl.fields.map((f) => f.key));
  const extra = [...new Set([...String(tpl.body).matchAll(/\{\{[#/]?(?:if |unless |each )?(\w+)\}\}/g)].map((m) => m[1]))]
    .filter((k) => !known.has(k) && !COMPUTED.has(k) && k !== "if" && k !== "unless" && k !== "each");
  return [...tpl.fields, ...extra.map((k) => ({ key: k, label: k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), group: "Other details", required: true }))];
}
window.PULSE_AGREEMENTS = { templateFields,  BUILTIN_TEMPLATES, JURISDICTIONS, lawPlace, venuePlace, noncompeteWarning, agreementVars, renderTemplate, signatureBlocks, longDate, lines };
