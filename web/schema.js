/* Fields, option lists, owners, review windows and agendas. Edit here to change the app. */
window.PULSE_SCHEMA = {
 "entities": {
  "opportunities": {
   "label": "Opportunities",
   "singular": "Opportunity",
   "title_field": "title",
   "status_field": "stage",
   "default_sort": "deadline",
   "list_fields": [
    "title",
    "kind",
    "agency",
    "deadline",
    "stage",
    "priority",
    "value",
    "owner"
   ],
   "fields": [
    {
     "name": "title",
     "type": "text",
     "label": "Title",
     "options": null
    },
    {
     "name": "kind",
     "type": "select",
     "label": "Type",
     "options": [
      "Federal Contract",
      "Consulting",
      "Subcontract",
      "Forecast",
      "Water Credit Project",
      "State/Local",
      "International",
      "Other"
     ]
    },
    {
     "name": "agency",
     "type": "text",
     "label": "Agency / Client",
     "options": null
    },
    {
     "name": "ref_no",
     "type": "text",
     "label": "Solicitation / Ref #",
     "options": null
    },
    {
     "name": "stage",
     "type": "select",
     "label": "Stage",
     "options": [
      "Identified",
      "Qualifying",
      "Pursuing",
      "Submitted",
      "Won",
      "Lost",
      "Missed",
      "Not Qualified",
      "No-Bid",
      "Cancelled"
     ]
    },
    {
     "name": "priority",
     "type": "select",
     "label": "Priority",
     "options": [
      "High",
      "Medium",
      "Low"
     ]
    },
    {
     "name": "deadline",
     "type": "date",
     "label": "Due date",
     "options": null
    },
    {
     "name": "value",
     "type": "number",
     "label": "Value (USD)",
     "options": null
    },
    {
     "name": "value_text",
     "type": "text",
     "label": "Value range",
     "options": null
    },
    {
     "name": "pwin",
     "type": "number",
     "label": "PWin %",
     "options": null
    },
    {
     "name": "owner",
     "type": "select",
     "label": "Owner",
     "options": [
      "Barasa",
      "Sohaib",
      "Robert",
      "Beckee"
     ]
    },
    {
     "name": "naics",
     "type": "text",
     "label": "NAICS",
     "options": null
    },
    {
     "name": "set_aside",
     "type": "text",
     "label": "Set-aside",
     "options": null
    },
    {
     "name": "location",
     "type": "text",
     "label": "Place of performance",
     "options": null
    },
    {
     "name": "contact_name",
     "type": "text",
     "label": "Contact",
     "options": null
    },
    {
     "name": "contact_email",
     "type": "email",
     "label": "Contact email",
     "options": null
    },
    {
     "name": "url",
     "type": "url",
     "label": "Link",
     "options": null
    },
    {
     "name": "notes",
     "type": "textarea",
     "label": "Notes",
     "options": null
    },
    {
     "name": "source",
     "type": "text",
     "label": "Source",
     "options": null
    }
   ]
  },
  "funding": {
   "label": "Funding",
   "singular": "Funding item",
   "title_field": "name",
   "status_field": "status",
   "default_sort": "deadline",
   "list_fields": [
    "name",
    "organization",
    "type",
    "deadline",
    "status",
    "amount_text",
    "owner"
   ],
   "fields": [
    {
     "name": "name",
     "type": "text",
     "label": "Program / application",
     "options": null
    },
    {
     "name": "organization",
     "type": "text",
     "label": "Organization",
     "options": null
    },
    {
     "name": "type",
     "type": "select",
     "label": "Type",
     "options": [
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
     ]
    },
    {
     "name": "status",
     "type": "select",
     "label": "Status",
     "options": [
      "Catalog",
      "Identified",
      "Pursuing",
      "Submitted",
      "Won",
      "Lost",
      "Missed",
      "Out of Scope",
      "Withdrawn"
     ]
    },
    {
     "name": "deadline",
     "type": "date",
     "label": "Deadline",
     "options": null
    },
    {
     "name": "amount",
     "type": "number",
     "label": "Amount (USD)",
     "options": null
    },
    {
     "name": "amount_text",
     "type": "text",
     "label": "Amount (as listed)",
     "options": null
    },
    {
     "name": "pwin",
     "type": "number",
     "label": "PWin %",
     "options": null
    },
    {
     "name": "owner",
     "type": "select",
     "label": "Owner",
     "options": [
      "Barasa",
      "Sohaib",
      "Robert",
      "Beckee"
     ]
    },
    {
     "name": "region",
     "type": "text",
     "label": "State / country",
     "options": null
    },
    {
     "name": "contact_email",
     "type": "email",
     "label": "Contact email",
     "options": null
    },
    {
     "name": "submitted_date",
     "type": "date",
     "label": "Submitted",
     "options": null
    },
    {
     "name": "decision_date",
     "type": "date",
     "label": "Decision date",
     "options": null
    },
    {
     "name": "url",
     "type": "url",
     "label": "Link",
     "options": null
    },
    {
     "name": "notes",
     "type": "textarea",
     "label": "Notes",
     "options": null
    },
    {
     "name": "source",
     "type": "text",
     "label": "Source",
     "options": null
    }
   ]
  },
  "contacts": {
   "label": "Contacts",
   "singular": "Contact",
   "title_field": "name",
   "status_field": "status",
   "default_sort": "name",
   "list_fields": [
    "name",
    "organization",
    "role",
    "email",
    "category",
    "status",
    "next_step_date",
    "owner"
   ],
   "fields": [
    {
     "name": "name",
     "type": "text",
     "label": "Name",
     "options": null
    },
    {
     "name": "organization",
     "type": "text",
     "label": "Organization",
     "options": null
    },
    {
     "name": "role",
     "type": "text",
     "label": "Role / title",
     "options": null
    },
    {
     "name": "email",
     "type": "email",
     "label": "Email",
     "options": null
    },
    {
     "name": "phone",
     "type": "text",
     "label": "Phone",
     "options": null
    },
    {
     "name": "category",
     "type": "select",
     "label": "Category",
     "options": [
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
     ]
    },
    {
     "name": "status",
     "type": "select",
     "label": "Status",
     "options": [
      "To Contact",
      "Contacted",
      "Responded",
      "Meeting Set",
      "Active",
      "Dormant",
      "Do Not Contact"
     ]
    },
    {
     "name": "owner",
     "type": "select",
     "label": "Owner",
     "options": [
      "Barasa",
      "Sohaib",
      "Robert",
      "Beckee"
     ]
    },
    {
     "name": "last_touch",
     "type": "date",
     "label": "Last touch",
     "options": null
    },
    {
     "name": "next_step",
     "type": "text",
     "label": "Next step",
     "options": null
    },
    {
     "name": "next_step_date",
     "type": "date",
     "label": "Next step due",
     "options": null
    },
    {
     "name": "location",
     "type": "text",
     "label": "Location",
     "options": null
    },
    {
     "name": "linkedin",
     "type": "url",
     "label": "LinkedIn",
     "options": null
    },
    {
     "name": "tags",
     "type": "text",
     "label": "Tags",
     "options": null
    },
    {
     "name": "notes",
     "type": "textarea",
     "label": "Notes",
     "options": null
    },
    {
     "name": "source",
     "type": "text",
     "label": "Source",
     "options": null
    }
   ]
  },
  "resources": {
   "label": "Resources",
   "singular": "Resource",
   "title_field": "name",
   "status_field": null,
   "default_sort": "category",
   "list_fields": [
    "name",
    "category",
    "agency",
    "url",
    "notes"
   ],
   "fields": [
    {
     "name": "name",
     "type": "text",
     "label": "Name",
     "options": null
    },
    {
     "name": "category",
     "type": "select",
     "label": "Category",
     "options": [
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
    {
     "name": "agency",
     "type": "text",
     "label": "Agency",
     "options": null
    },
    {
     "name": "url",
     "type": "url",
     "label": "Link",
     "options": null
    },
    {
     "name": "contact",
     "type": "text",
     "label": "Contact",
     "options": null
    },
    {
     "name": "notes",
     "type": "textarea",
     "label": "Notes",
     "options": null
    }
   ]
  },
  "actions": {
   "label": "Action items",
   "singular": "Action item",
   "title_field": "text",
   "status_field": "status",
   "default_sort": "due_date",
   "list_fields": [
    "text",
    "owner",
    "due_date",
    "status",
    "linked"
   ],
   "fields": [
    {
     "name": "text",
     "type": "text",
     "label": "Action",
     "options": null
    },
    {
     "name": "owner",
     "type": "select",
     "label": "Owner",
     "options": [
      "Barasa",
      "Sohaib",
      "Robert",
      "Beckee"
     ]
    },
    {
     "name": "due_date",
     "type": "date",
     "label": "Due",
     "options": null
    },
    {
     "name": "status",
     "type": "select",
     "label": "Status",
     "options": [
      "Open",
      "Done",
      "Dropped"
     ]
    },
    {
     "name": "review_id",
     "type": "number",
     "label": "Review",
     "options": null
    },
    {
     "name": "linked_type",
     "type": "text",
     "label": "Linked type",
     "options": null
    },
    {
     "name": "linked_id",
     "type": "number",
     "label": "Linked id",
     "options": null
    },
    {
     "name": "notes",
     "type": "textarea",
     "label": "Notes",
     "options": null
    }
   ]
  }
 },
 "cadences": {
  "daily": {
   "label": "Daily",
   "lookback": 1,
   "ahead": 7
  },
  "weekly": {
   "label": "Weekly",
   "lookback": 7,
   "ahead": 30
  },
  "monthly": {
   "label": "Monthly",
   "lookback": 31,
   "ahead": 60
  },
  "quarterly": {
   "label": "Quarterly",
   "lookback": 92,
   "ahead": 120
  }
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
 "active": {
  "opportunities": [
   "Identified",
   "Qualifying",
   "Pursuing",
   "Submitted"
  ],
  "funding": [
   "Identified",
   "Pursuing",
   "Submitted"
  ]
 }
};
