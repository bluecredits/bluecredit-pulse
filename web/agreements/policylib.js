/* Pulse · starter policies for a small US company. Each is a short, plain-English starting point that an admin adds as a
   Draft, edits for the company (and its states) and publishes. They are not legal advice: have counsel review them.
   Placeholders in [brackets] are for the company to fill in. Bodies are Markdown. */
"use strict";
const POLICY_LIBRARY = [
  { key: "handbook-ack", title: "Employee Handbook Acknowledgment", category: "Employee relations", audience: "Staff", review_months: 12,
    summary: "How the handbook and policies work, at-will employment, and that policies can change.",
    body: `## Purpose
This handbook and the policies in Pulse explain how [Company] works and what we expect of each other.

## How it works
- Policies apply to everyone they name. If a policy and a written agreement with you conflict, the agreement controls.
- [Company] may change, add or retire policies. We will publish changes in Pulse and ask you to certify the new version.
- Questions go to your manager or to [People contact].

## At-will employment (United States)
Unless a written agreement signed by an officer says otherwise, employment with [Company] is at will: you or the company may end it at any time, with or without cause or notice. Nothing in the handbook or any policy changes this.

## Your certification
Certifying in Pulse confirms that you have read the policies that apply to you, understand them, and know where to find them.` },

  { key: "eeo-harassment", title: "Equal Employment Opportunity and Anti-Harassment", category: "Employee relations", audience: "Everyone", review_months: 12,
    summary: "No discrimination, harassment or retaliation; how to report and how reports are handled.",
    body: `## Our commitment
[Company] provides equal employment opportunity and does not discriminate on the basis of race, color, religion, sex (including pregnancy, sexual orientation and gender identity), national origin, age, disability, genetic information, veteran status or any other status protected by law. This covers hiring, pay, promotion, discipline, training and every other part of work.

## Harassment is not allowed
Harassment is unwelcome conduct based on a protected status that makes work intimidating, hostile or offensive, or that is made a condition of work. Sexual harassment includes unwelcome advances, requests for sexual favors and other verbal or physical conduct of a sexual nature. This applies at work, at work events, online and with clients, partners and contractors.

## Reporting
- Tell your manager, [People contact] or any officer. You do not have to report to the person involved.
- Managers who receive a report must pass it on right away.
- We investigate promptly and as confidentially as we can, and take appropriate action.

## No retaliation
No one will be punished for reporting in good faith or for taking part in an investigation. Retaliation is itself a violation of this policy.

## Accommodations
We provide reasonable accommodations for disability, pregnancy and religious practice unless doing so would cause undue hardship. Ask [People contact].` },

  { key: "code-of-conduct", title: "Code of Conduct and Conflicts of Interest", category: "Ethics and conduct", audience: "Everyone", review_months: 12,
    summary: "Honesty, fair dealing, gifts, conflicts of interest and speaking up.",
    body: `## Act with integrity
Be honest with customers, partners, government officials and each other. Do not falsify records, timecards, invoices or reports.

## Conflicts of interest
A conflict exists when a personal interest could affect, or look like it affects, your judgment for [Company]. Tell your manager in writing before you:
- hold a financial interest in a customer, supplier or competitor;
- work for or advise another company in the same field;
- hire or supervise a relative or close personal partner.

## Gifts and hospitality
Modest, occasional gifts and meals (under [$100] a year from one source) are fine if they do not create an obligation. Never offer or accept cash, gift cards or anything of value to win business. **Do not give anything of value to a government employee** unless the rules of that agency allow it; when in doubt, ask first.

## Anti-bribery
[Company] does not offer, pay, request or accept bribes or kickbacks, directly or through others, anywhere in the world (including under the U.S. Foreign Corrupt Practices Act).

## Speaking up
Report suspected violations to your manager or [Ethics contact]. We do not tolerate retaliation for good-faith reports.` },

  { key: "safety-health", title: "Workplace Safety and Health (OSHA)", category: "Safety and health", audience: "Everyone", review_months: 12,
    summary: "Everyone's safety duties, reporting injuries and hazards, and what the company records and reports to OSHA.",
    body: `## Our commitment
[Company] provides a workplace free from recognized hazards, as the Occupational Safety and Health Act requires, and follows the OSHA standards that apply to our work. Safety comes before schedule.

## Your part
- Follow safe work practices, site rules and client safety requirements.
- Use the protective equipment your task requires.
- Stop work and tell your supervisor if something is unsafe. You will not be penalized for raising a safety concern.

## Report injuries and near misses
Report every work-related injury, illness or near miss to your supervisor **the same day**, however minor. In an emergency call 911 first.

## What the company does
- Records work-related injuries and illnesses where OSHA's recordkeeping rule (29 CFR 1904) requires it, and posts the annual summary (Form 300A) from February 1 to April 30.
- Reports to OSHA within **8 hours** any work-related fatality, and within **24 hours** any in-patient hospitalization, amputation or loss of an eye.
- Displays the OSHA "Job Safety and Health: It's the Law" poster.
- Trains people on the hazards of their work, including hazardous chemicals (Hazard Communication, 29 CFR 1910.1200) where they apply.

## Field work
Before working at a client or field site, review the site's safety plan and hazards. Do not enter confined spaces, work at heights or near traffic, water or energized equipment without the training and equipment the task needs.

Questions go to [Safety contact].` },

  { key: "emergency-action", title: "Emergency Action Plan", category: "Safety and health", audience: "Everyone", review_months: 12,
    summary: "What to do in a fire, medical emergency, severe weather or other emergency.",
    body: `## Reporting an emergency
Call **911**, then tell [Emergency contact] at [phone].

## Evacuation
- Leave by the nearest safe exit; do not use elevators.
- Meet at [assembly point] so we can account for everyone.
- Do not go back inside until emergency services say it is safe.

## Shelter in place
For severe weather, go to [interior room or lowest floor] away from windows. For an outside threat, lock doors and stay out of sight.

## Medical emergencies
Call 911. Use the first aid kit at [location]. Only trained people should give first aid or CPR.

## Remote and field staff
Know the address of where you are working, the nearest hospital and the site's own emergency plan. Check in with [contact] after any emergency.

## Note
OSHA requires a written emergency action plan for employers with more than 10 employees where a fire or emergency standard applies (29 CFR 1910.38); smaller employers may communicate it orally. This plan is reviewed with each new employee and whenever it changes.` },

  { key: "drug-alcohol", title: "Drug- and Alcohol-Free Workplace", category: "Safety and health", audience: "Everyone", review_months: 12,
    summary: "No impairment at work; what happens with a violation; where to get help.",
    body: `## Rule
Do not work, drive for work or operate equipment while impaired by alcohol, cannabis, illegal drugs or misused prescription drugs. Making, distributing, possessing or using illegal drugs at work is prohibited.

## Company events
Moderate alcohol at approved company events is allowed. Never drive impaired.

## Prescription medicine
If a medicine could affect your safety at work, tell your supervisor (you do not need to say what it is) so we can adjust your duties.

## Testing
Where the law, a client contract or a government contract requires it, [Company] may test for drugs or alcohol, following applicable law.

## Federal contracts
If [Company] holds a covered federal contract or grant, employees must tell the company within 5 days of a criminal drug conviction for a violation at work, as the Drug-Free Workplace Act requires.

## Help
We encourage anyone with a substance problem to seek help before it affects their work. Ask [People contact] about available resources; asking will be handled confidentially.` },

  { key: "time-pay", title: "Hours, Timekeeping and Pay", category: "Workplace", audience: "Staff", review_months: 12,
    summary: "Recording time accurately, overtime approval, pay days and correcting pay errors.",
    body: `## Timekeeping
Record the hours you work on each project in Pulse Timecards, accurately and each week. Never record time for someone else or work "off the clock". Falsifying time records is serious misconduct.

## Overtime (non-exempt employees)
Non-exempt employees are paid overtime as federal and state law require (generally 1.5 times the regular rate after 40 hours in a workweek). Get your manager's approval before working overtime; approved or not, all hours worked are paid.

## Breaks
Breaks and meal periods follow the law of the state where you work.

## Pay
- Pay days are [every other Friday / the 15th and last day of the month].
- Pay statements show hours (if non-exempt), pay and deductions.

## Pay errors
If your pay is wrong, tell [Payroll contact] right away. We correct errors promptly, and no one will be retaliated against for raising a pay concern.` },

  { key: "pto-leave", title: "Time Off and Leave", category: "Benefits and leave", audience: "Staff", review_months: 12,
    summary: "Vacation, sick time, holidays, leave required by law and how to request time off.",
    body: `## Requesting time off
Request time off in Pulse Tickets (Time off), at least [two weeks] ahead for vacation when you can. Sick time can be requested the same day.

## Paid time off
| Type | Amount |
| --- | --- |
| Vacation | [X] days a year, earned each pay period |
| Sick time | [X] days a year, or what your state or city requires if more |
| Holidays | [list holidays] |

## Leave required by law
[Company] follows the leave laws that apply to it and where you work, which may include family and medical leave (the federal FMLA applies to employers with 50 or more employees), military leave (USERRA), jury duty, voting and state paid-leave programs.

## Unpaid leave
Other unpaid leave may be approved case by case. Ask [People contact].` },

  { key: "remote-work", title: "Remote and Hybrid Work", category: "Workplace", audience: "Everyone", review_months: 12,
    summary: "Availability, workspace, equipment and security when working away from the office.",
    body: `## Expectations
- Be reachable during your agreed working hours and keep your calendar current.
- Join meetings with video on where practical.
- Your results and conduct standards are the same wherever you work.

## Workspace
Keep a safe, reasonably private workspace. Report any work-related injury at home as you would at the office.

## Equipment
Company equipment stays company property; return it when asked or when you leave (Pulse Tickets, Return an asset). Report loss or theft right away.

## Security
Follow the Data Security and Acceptable Use policy: lock your screen, use the company's approved tools, avoid public Wi-Fi without protection and do not let others use company devices.

## Location
Tell [People contact] before working from another state or country for more than [2 weeks]; it can affect taxes and employment law.` },

  { key: "data-security", title: "Data Security and Acceptable Use", category: "Data and IT", audience: "Everyone", review_months: 12,
    summary: "Protecting company and client information, using systems properly and reporting incidents.",
    body: `## Protect information
- Treat client, employee and company information as confidential unless it is clearly public.
- Share it only with people who need it for their work, using company-approved tools.
- Do not put confidential information into personal email, personal cloud storage or public AI tools unless the company has approved the tool for that data.

## Accounts and devices
- Use strong, unique passwords and turn on multi-factor authentication wherever it is offered.
- Keep devices updated and screen-locked; do not disable security software.
- Never share your login.

## Acceptable use
Company systems are for work; light personal use is fine if it does not interfere with work or break this policy. Do not use them for anything illegal, harassing or that infringes others' rights. [Company] may monitor its systems as the law allows.

## Incidents
Report a lost device, suspicious email you clicked, or any suspected breach to [IT contact] **immediately**. Fast reporting limits harm; you will not be punished for an honest mistake reported promptly.

## Leaving the company
Return all devices and information, and do not keep copies.` },

  { key: "expenses", title: "Travel and Expense Reimbursement", category: "Finance", audience: "Everyone", review_months: 12,
    summary: "What is reimbursed, approvals, receipts and how to submit.",
    body: `## Approval
Get approval before booking travel or spending more than [$250] (Pulse Tickets, Travel or Purchase or expense).

## What is reimbursed
Reasonable, necessary business costs: economy airfare booked early, mid-range lodging, ground transport, business mileage at the IRS standard rate, and meals while traveling up to [$X] a day.

## What is not
Personal travel, upgrades without approval, fines, alcohol (unless with a client and approved), and expenses already paid by a client.

## Submitting
Submit expenses within [30] days with itemized receipts for anything over [$25], the business purpose and the project to charge.

## Government contracts
Travel charged to a government contract follows that contract's rules, which may include federal per diem limits.` },

  { key: "whistleblower", title: "Whistleblower and Non-Retaliation", category: "Ethics and conduct", audience: "Everyone", review_months: 12,
    summary: "How to raise concerns about fraud, safety or legal violations without fear of retaliation.",
    body: `## Raise concerns
If you believe something illegal, unsafe, fraudulent or against our policies is happening, tell your manager, [Ethics contact] or any officer. You can report anonymously by [method].

## What you can report
Fraud, false claims to customers or the government, accounting irregularities, safety hazards, discrimination or harassment, bribery, and data breaches, among others.

## Protection
[Company] does not retaliate against anyone who reports in good faith or helps an investigation. Nothing in our policies or agreements stops you from reporting possible violations of law to a government agency, or from taking part in a government investigation, or requires you to tell the company first.

## Federal contractors
Employees of federal contractors are protected when they disclose information about gross mismanagement, waste, abuse of authority, or violations of law related to a federal contract or grant (41 U.S.C. 4712).` },

  { key: "records", title: "Records Retention", category: "Finance", audience: "Staff", review_months: 24,
    summary: "How long the company keeps key records and how they are disposed of.",
    body: `## Why
We keep records long enough to meet legal, tax and contract requirements, then dispose of them securely.

## Minimum retention
| Record | Keep for |
| --- | --- |
| Payroll and time records | 3 years (FLSA); 4 years for payroll tax records |
| Form I-9 | 3 years after hire or 1 year after employment ends, whichever is later |
| Personnel files and job applications | At least 1 year after the decision or separation (longer under some state laws) |
| OSHA injury and illness logs | 5 years |
| Tax returns and supporting records | 7 years |
| Contracts and agreements | 6 years after they end |
| Government contract records | 3 years after final payment, or as the contract states |

## Holds
If litigation, an audit or an investigation is expected, keep everything related until [Company] lifts the hold, whatever the schedule says.

## Disposal
Shred paper and securely delete electronic records containing personal or confidential information.` },
];
window.POLICY_LIBRARY = POLICY_LIBRARY;

/* Common filings, registrations and postings for a small US company. Each says when it applies; the admin picks what fits
   and sets the real dates. */
const COMPLIANCE_SUGGESTIONS = [
  { title: "SAM.gov registration renewal", category: "Registration", authority: "GSA (SAM.gov)", repeats: "Yearly", note: "If you bid on federal work. Renew before it expires, 365 days after activation." },
  { title: "State annual report", category: "Registration", authority: "Secretary of State", repeats: "Yearly", note: "Due date depends on your state and entity type." },
  { title: "Delaware franchise tax and annual report", category: "Tax", authority: "Delaware Division of Corporations", repeats: "Yearly", note: "Delaware corporations: due March 1. LLCs: annual tax due June 1." },
  { title: "Registered agent renewal", category: "Registration", authority: "Registered agent", repeats: "Yearly", note: "For each state you're registered in." },
  { title: "Business license renewal", category: "License", authority: "City or county", repeats: "Yearly", note: "Where your office is located." },
  { title: "Federal income tax return", category: "Tax", authority: "IRS", repeats: "Yearly", note: "Form 1120 (C corp, 15th day of the 4th month), 1120-S or 1065 (15th day of the 3rd month)." },
  { title: "Quarterly payroll tax return (Form 941)", category: "Tax", authority: "IRS", repeats: "Quarterly", note: "If you have employees. Due the last day of the month after each quarter." },
  { title: "Annual unemployment tax (Form 940)", category: "Tax", authority: "IRS", repeats: "Yearly", note: "If you have employees. Due January 31." },
  { title: "W-2 and 1099-NEC filing", category: "Tax", authority: "IRS / SSA", repeats: "Yearly", note: "Give to workers and file by January 31." },
  { title: "State payroll and unemployment returns", category: "Tax", authority: "State revenue / workforce agency", repeats: "Quarterly", note: "Each state where you have employees." },
  { title: "Sales and use tax return", category: "Tax", authority: "State revenue agency", repeats: "Monthly", note: "Only if you sell taxable goods or services." },
  { title: "Post OSHA Form 300A summary", category: "Safety and health", authority: "OSHA", repeats: "Yearly", note: "Feb 1 – Apr 30, if you have more than 10 employees and aren't in an exempt industry." },
  { title: "Labor law posters up to date", category: "Posting", authority: "U.S. DOL and state", repeats: "Yearly", note: "Federal and state required posters, physically and for remote staff." },
  { title: "EEO-1 report", category: "Employment", authority: "EEOC", repeats: "Yearly", note: "Employers with 100+ employees, or federal contractors with 50+ employees and a $50,000+ contract." },
  { title: "VETS-4212 report", category: "Employment", authority: "U.S. DOL", repeats: "Yearly", note: "Federal contractors with a contract of $150,000 or more. Due September 30." },
  { title: "Workers' compensation insurance renewal", category: "Insurance", authority: "Insurer", repeats: "Yearly", note: "Required in most states once you have employees." },
  { title: "General liability insurance renewal", category: "Insurance", authority: "Insurer", repeats: "Yearly", note: "Send updated certificates to clients that require them." },
  { title: "Professional liability (E&O) insurance renewal", category: "Insurance", authority: "Insurer", repeats: "Yearly", note: "Often required by consulting and engineering contracts." },
  { title: "Small business certification renewal", category: "Certification", authority: "State or SBA", repeats: "Every 3 years", note: "E.g. state small, women- or minority-owned certifications; check your program's term." },
  { title: "Professional license renewal", category: "License", authority: "State licensing board", repeats: "Every 2 years", note: "For each licensed professional (e.g. PE), with continuing education." },
  { title: "Annual policy review", category: "Other", authority: "Internal", repeats: "Yearly", note: "Review and republish company policies; Pulse asks people to certify new versions." },
];
window.COMPLIANCE_SUGGESTIONS = COMPLIANCE_SUGGESTIONS;
