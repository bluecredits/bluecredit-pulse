"""Single source of truth for entities, fields and option lists.

The API, the importer and the UI are all driven from this file, so adding a
field or an option here is usually the only change you need.
"""

OPP_STAGES = ["Identified", "Qualifying", "Pursuing", "Submitted", "Won", "Lost",
              "Missed", "Not Qualified", "No-Bid", "Cancelled"]
FUNDING_STATUSES = ["Catalog", "Identified", "Pursuing", "Submitted", "Won", "Lost",
                    "Missed", "Out of Scope", "Withdrawn"]
ACTIVE_OPP = ["Identified", "Qualifying", "Pursuing", "Submitted"]
ACTIVE_FUNDING = ["Identified", "Pursuing", "Submitted"]
OWNERS = ["Barasa", "Sohaib", "Robert", "Beckee"]

ENTITIES = {
    "opportunities": {
        "label": "Opportunities",
        "singular": "Opportunity",
        "title_field": "title",
        "status_field": "stage",
        "default_sort": "deadline",
        "list_fields": ["title", "kind", "agency", "deadline", "stage", "priority", "value", "owner"],
        "fields": [
            ("title", "text", "Title", None),
            ("kind", "select", "Type", ["Federal Contract", "Consulting", "Subcontract", "Forecast",
                                         "Water Credit Project", "State/Local", "International", "Other"]),
            ("agency", "text", "Agency / Client", None),
            ("ref_no", "text", "Solicitation / Ref #", None),
            ("stage", "select", "Stage", OPP_STAGES),
            ("priority", "select", "Priority", ["High", "Medium", "Low"]),
            ("deadline", "date", "Due date", None),
            ("value", "number", "Value (USD)", None),
            ("value_text", "text", "Value range", None),
            ("pwin", "number", "PWin %", None),
            ("owner", "select", "Owner", OWNERS),
            ("naics", "text", "NAICS", None),
            ("set_aside", "text", "Set-aside", None),
            ("location", "text", "Place of performance", None),
            ("contact_name", "text", "Contact", None),
            ("contact_email", "email", "Contact email", None),
            ("url", "url", "Link", None),
            ("notes", "textarea", "Notes", None),
            ("source", "text", "Source", None),
        ],
    },
    "funding": {
        "label": "Funding",
        "singular": "Funding item",
        "title_field": "name",
        "status_field": "status",
        "default_sort": "deadline",
        "list_fields": ["name", "organization", "type", "deadline", "status", "amount_text", "owner"],
        "fields": [
            ("name", "text", "Program / application", None),
            ("organization", "text", "Organization", None),
            ("type", "select", "Type", ["Grant", "Accelerator", "Pitch Competition", "Fellowship", "VC",
                                         "Seed Round", "Loan", "Award", "Incubator", "SBIR/STTR",
                                         "Resources", "Other"]),
            ("status", "select", "Status", FUNDING_STATUSES),
            ("deadline", "date", "Deadline", None),
            ("amount", "number", "Amount (USD)", None),
            ("amount_text", "text", "Amount (as listed)", None),
            ("pwin", "number", "PWin %", None),
            ("owner", "select", "Owner", OWNERS),
            ("region", "text", "State / country", None),
            ("contact_email", "email", "Contact email", None),
            ("submitted_date", "date", "Submitted", None),
            ("decision_date", "date", "Decision date", None),
            ("url", "url", "Link", None),
            ("notes", "textarea", "Notes", None),
            ("source", "text", "Source", None),
        ],
    },
    "contacts": {
        "label": "Contacts",
        "singular": "Contact",
        "title_field": "name",
        "status_field": "status",
        "default_sort": "name",
        "list_fields": ["name", "organization", "role", "email", "category", "status", "next_step_date", "owner"],
        "fields": [
            ("name", "text", "Name", None),
            ("organization", "text", "Organization", None),
            ("role", "text", "Role / title", None),
            ("email", "email", "Email", None),
            ("phone", "text", "Phone", None),
            ("category", "select", "Category", ["Government", "Corporate", "Corporate Prospect", "Investor",
                                                 "Prime Contractor", "Partner", "NGO", "Utility", "Expert",
                                                 "Academic", "Mailing List", "Other"]),
            ("status", "select", "Status", ["To Contact", "Contacted", "Responded", "Meeting Set",
                                             "Active", "Dormant", "Do Not Contact"]),
            ("owner", "select", "Owner", OWNERS),
            ("last_touch", "date", "Last touch", None),
            ("next_step", "text", "Next step", None),
            ("next_step_date", "date", "Next step due", None),
            ("location", "text", "Location", None),
            ("linkedin", "url", "LinkedIn", None),
            ("tags", "text", "Tags", None),
            ("notes", "textarea", "Notes", None),
            ("source", "text", "Source", None),
        ],
    },
    "resources": {
        "label": "Resources",
        "singular": "Resource",
        "title_field": "name",
        "status_field": None,
        "default_sort": "category",
        "list_fields": ["name", "category", "agency", "url", "notes"],
        "fields": [
            ("name", "text", "Name", None),
            ("category", "select", "Category", ["Bid Board", "Forecast Portal", "Events", "Registration",
                                                 "Below-SAT Strategy", "District Office", "Feasibility Program",
                                                 "Training", "Other"]),
            ("agency", "text", "Agency", None),
            ("url", "url", "Link", None),
            ("contact", "text", "Contact", None),
            ("notes", "textarea", "Notes", None),
        ],
    },
    "actions": {
        "label": "Action items",
        "singular": "Action item",
        "title_field": "text",
        "status_field": "status",
        "default_sort": "due_date",
        "list_fields": ["text", "owner", "due_date", "status", "linked"],
        "fields": [
            ("text", "text", "Action", None),
            ("owner", "select", "Owner", OWNERS),
            ("due_date", "date", "Due", None),
            ("status", "select", "Status", ["Open", "Done", "Dropped"]),
            ("review_id", "number", "Review", None),
            ("linked_type", "text", "Linked type", None),
            ("linked_id", "number", "Linked id", None),
            ("notes", "textarea", "Notes", None),
        ],
    },
}

CADENCES = {
    # lookback = days of history to summarise; ahead = days of upcoming items
    "daily":     {"label": "Daily",     "lookback": 1,  "ahead": 7},
    "weekly":    {"label": "Weekly",    "lookback": 7,  "ahead": 30},
    "monthly":   {"label": "Monthly",   "lookback": 31, "ahead": 60},
    "quarterly": {"label": "Quarterly", "lookback": 92, "ahead": 120},
}

AGENDAS = {
    "daily": [
        "Yesterday: what moved (submissions, replies, calls)",
        "Today: top 3 priorities per person",
        "Deadlines in the next 7 days",
        "Blockers / asks",
    ],
    "weekly": [
        "Last week's action items — close out",
        "Submissions and decisions this week",
        "Deadlines in the next 30 days — go / no-go",
        "Outreach and follow-ups due",
        "New opportunities to qualify",
    ],
    "monthly": [
        "Pipeline by stage and value",
        "Wins, losses, lessons learned",
        "Funding: submitted, pending decisions, upcoming",
        "Partner / subcontractor relationships",
        "Professional development (FE/PE, CFM, PMP, GSA MAS)",
        "Next month's targets",
    ],
    "quarterly": [
        "Quarter results vs goals (submissions, win rate, $ won, $ raised)",
        "Performance by owner",
        "Strategy: agencies, NAICS, markets — keep / add / drop",
        "Fundraise and investor pipeline",
        "Goals for next quarter",
    ],
}


def field_names(entity):
    return [f[0] for f in ENTITIES[entity]["fields"]]


def field_types(entity):
    return {f[0]: f[1] for f in ENTITIES[entity]["fields"]}


def public_schema():
    out = {}
    for name, e in ENTITIES.items():
        out[name] = {
            "label": e["label"], "singular": e["singular"], "title_field": e["title_field"],
            "status_field": e["status_field"], "default_sort": e["default_sort"],
            "list_fields": e["list_fields"],
            "fields": [{"name": n, "type": t, "label": l, "options": o} for n, t, l, o in e["fields"]],
        }
    return {"entities": out, "cadences": CADENCES, "agendas": AGENDAS, "owners": OWNERS,
            "active": {"opportunities": ACTIVE_OPP, "funding": ACTIVE_FUNDING}}
