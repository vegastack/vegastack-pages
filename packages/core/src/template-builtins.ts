import type { TemplateProperty } from "./template-service";

export type BuiltinTemplateCategory =
  | "product"
  | "engineering"
  | "marketing"
  | "business"
  | "work";

export type BuiltinTemplateSpec = {
  slug: string;
  name: string;
  description: string;
  category: BuiltinTemplateCategory;
  properties: TemplateProperty[];
  body: string;
};

const prdBody = `# {{ title }}

## Problem
<!-- guidance: 2–4 sentences. Who is affected, what breaks today, what evidence we have. No solutions yet. -->

## Goals
<!-- guidance: Bullet 3–5 outcomes this work must achieve. Phrase as user/business outcomes, not features. -->

## Non-goals
<!-- guidance: What is explicitly out of scope so reviewers don't assume otherwise. -->

## User stories
<!-- guidance: As a <persona>, I want <action>, so that <outcome>. Cover the primary path and one or two edges. -->

## Proposed solution
<!-- guidance: The shape of the change. Diagrams welcome. Keep implementation specifics in the tech design doc. -->

## Success metrics
<!-- guidance: How we will know this worked. Name the metric, the baseline, and the target. -->

## Risks & open questions
<!-- guidance: Top risks and the open calls that block decisions. Tag owners. -->
`;

const featureBriefBody = `# {{ title }}

## Why
<!-- guidance: 1–2 sentences. Why now? What signal triggered this? -->

## What
<!-- guidance: The smallest change that addresses the signal. Bullet what's in and what's out. -->

## How we'll measure it
<!-- guidance: One metric or qualitative signal. If we can't tell whether it worked, scope it down. -->

## Rollout
<!-- guidance: Who sees it first, what's the safety net, when do we expand. -->
`;

const discoveryBody = `# {{ title }}

## Method
<!-- guidance: Who we spoke to, how, and over what window. Sample size and selection criteria. -->

## Themes
<!-- guidance: 3–5 themes that recurred. One sentence per theme, then supporting quotes below. -->

## Quotes
<!-- guidance: Verbatim quotes that anchor each theme. Attribute by role, not name unless agreed. -->

## Implications
<!-- guidance: What this means for the product. Resist jumping to features — name the constraints we now know. -->

## Next steps
<!-- guidance: Concrete follow-ups, owners, dates. -->
`;

const rfcBody = `# {{ title }}

## Context
<!-- guidance: What is the system today and why does it need to change? Link relevant code paths. -->

## Goals & non-goals
<!-- guidance: Bullets. Be ruthless about non-goals — they prevent scope drift in review. -->

## Options considered
<!-- guidance: For each option: summary, pros, cons, complexity. Include "do nothing" if relevant. -->

### Option A — <name>
### Option B — <name>

## Recommendation
<!-- guidance: Pick one and explain why over the alternatives. Don't hedge. -->

## Rollout plan
<!-- guidance: Migration, feature flags, dual-writes, rollback. Call out what's reversible vs. one-way. -->

## Risks
<!-- guidance: Top 3 with mitigations. Include the one you're most worried about. -->

## Open questions
<!-- guidance: Anything that needs sign-off before implementation begins. -->
`;

const postmortemBody = `# {{ title }}

## Summary
<!-- guidance: One paragraph: what happened, when, who was affected, current status. -->

## Impact
<!-- guidance: Quantify it. Users affected, revenue, latency, error rate. If you can't quantify, say so. -->

## Timeline
<!-- guidance: ISO timestamps in your reporting timezone. Detection → mitigation → resolution. -->

## Root cause
<!-- guidance: Why this happened — not who did what. Trace it to a class of cause (config, code, capacity, dependency). -->

## What went well
<!-- guidance: Detection, response, communication — anything the next incident should preserve. -->

## What didn't
<!-- guidance: Where we lost time. Be specific so we can fix the system, not just feel bad. -->

## Action items
<!-- guidance: Each item: title, owner, target date, severity. Track in your normal tracker. -->
`;

const adrBody = `# {{ title }}

## Context
<!-- guidance: The forces at play: technical, organizational, political. Two paragraphs max. -->

## Decision
<!-- guidance: The decision in active voice. "We will…" -->

## Consequences
<!-- guidance: What becomes easier, what becomes harder, what we'll have to revisit. -->
`;

const runbookBody = `# {{ title }}

## Symptoms
<!-- guidance: What does this incident look like from outside (alerts, user reports, dashboards)? -->

## Quick checks
<!-- guidance: First 60 seconds. Commands, dashboards, and what "normal" looks like for each. -->

## Mitigations
<!-- guidance: Ordered steps. Mark each as "safe" or "requires approval". Include rollback for risky steps. -->

## Escalation
<!-- guidance: When to page who, and what information to bring. -->

## Related links
<!-- guidance: Dashboards, design docs, recent postmortems. -->
`;

const launchBody = `# {{ title }}

## Narrative
<!-- guidance: One paragraph the team can quote. What's the story we're telling and to whom? -->

## Audiences
<!-- guidance: Primary and secondary. Note what each cares about. -->

## Channels
<!-- guidance: Where we'll show up — blog, docs, social, email, partners. Owner per channel. -->

## Assets
<!-- guidance: Copy, visuals, demos, sample code. Link drafts. -->

## Schedule
<!-- guidance: Pre-announce, launch day, post-launch. Dates with owners. -->

## Success metrics
<!-- guidance: What does "launched well" look like at day 1, week 1, month 1? -->
`;

const campaignBody = `# {{ title }}

## Objective
<!-- guidance: One sentence. Awareness, acquisition, activation, expansion — pick one. -->

## Audience
<!-- guidance: Who specifically. Segments, ICPs, exclusions. -->

## Message
<!-- guidance: Headline, supporting points, proof. Same copy across channels unless you justify variants. -->

## KPIs
<!-- guidance: Leading and lagging. Define before you start running, not after. -->

## Budget
<!-- guidance: Total, by channel, with assumed CPM/CPC where relevant. -->

## Timeline
<!-- guidance: Major beats and owners. -->
`;

const onePagerBody = `# {{ title }}

## The problem
<!-- guidance: Exec-readable. No jargon. Why does this matter to the business right now? -->

## What we'll do
<!-- guidance: The shape of the work in 3 bullets. -->

## What we need
<!-- guidance: People, budget, decisions. Make the asks concrete. -->

## Timeline
<!-- guidance: Quarter-level milestones. Don't pretend you know dates you don't. -->

## Risks
<!-- guidance: Top 2 with mitigations. -->
`;

const meetingBody = `# {{ title }}

## Attendees
<!-- guidance: List. Star (*) the decision-makers. -->

## Agenda
<!-- guidance: Bullets, time-boxed. -->

## Decisions
<!-- guidance: What we agreed. If contested, who has the final call and by when. -->

## Action items
<!-- guidance: Owner — action — due date. One per line. -->

## Notes
<!-- guidance: Anything worth remembering that didn't become a decision or action. -->
`;

const weeklyBody = `# {{ title }}

## Shipped
<!-- guidance: What landed this week. Link the change/PR. Keep to the things a reader outside the team would care about. -->

## In flight
<!-- guidance: What's being worked on right now and the next milestone. -->

## Blocked
<!-- guidance: What's stuck and what would unblock it. Tag the person who can help. -->

## Next week
<!-- guidance: 3–5 bullets. -->
`;

const oneOnOneBody = `# {{ title }}

## Recurring topics
<!-- guidance: Goals, growth, feedback. Update as priorities change — these don't reset every week. -->

## This week
<!-- guidance: Wins, blockers, decisions you want input on. -->

## Parking lot
<!-- guidance: Things to revisit later. Date them so they don't grow stale. -->

## Action items
<!-- guidance: Owner — action — due date. -->
`;

const kickoffBody = `# {{ title }}

## Scope
<!-- guidance: One paragraph. What we will deliver and the boundary of "done". -->

## Team
<!-- guidance: Names and roles. Note % allocation if it's not 100%. -->

## Milestones
<!-- guidance: 3–6 dated checkpoints. Avoid month-long opaque chunks — break them down. -->

## Risks
<!-- guidance: Top 3 with mitigations and owners. -->

## Communication
<!-- guidance: Standups, demos, status update cadence, where decisions get written down. -->
`;

const retroBody = `# {{ title }}

## What went well
<!-- guidance: Specific moments worth preserving. -->

## What didn't
<!-- guidance: Specific moments worth changing. Critique the system, not the people. -->

## What we'll try next
<!-- guidance: 2–3 concrete experiments. Each has an owner and a way to tell if it worked. -->
`;

export const builtinTemplates: BuiltinTemplateSpec[] = [
  {
    slug: "prd",
    name: "PRD",
    description:
      "Product requirements with problem, goals, user stories, metrics, and risks.",
    category: "product",
    body: prdBody,
    properties: [
      {
        key: "owner",
        label: "Owner",
        type: "text",
        required: true,
        help: "Single accountable person for shipping this.",
      },
      {
        key: "status",
        label: "Status",
        type: "select",
        options: ["draft", "in_review", "approved", "shipped", "shelved"],
        default: "draft",
      },
      {
        key: "target_date",
        label: "Target date",
        type: "date",
        help: "Best-effort ship date — update as scope changes.",
      },
      { key: "tags", label: "Tags", type: "tags" },
    ],
  },
  {
    slug: "feature-brief",
    name: "Feature brief",
    description:
      "Short PRD for incremental work — why, what, measurement, rollout.",
    category: "product",
    body: featureBriefBody,
    properties: [
      { key: "owner", label: "Owner", type: "text", required: true },
      {
        key: "status",
        label: "Status",
        type: "select",
        options: ["draft", "in_review", "shipped"],
        default: "draft",
      },
      { key: "tags", label: "Tags", type: "tags" },
    ],
  },
  {
    slug: "discovery-notes",
    name: "Discovery notes",
    description:
      "User research synthesis with method, themes, quotes, implications.",
    category: "product",
    body: discoveryBody,
    properties: [
      { key: "researcher", label: "Researcher", type: "text", required: true },
      {
        key: "research_date",
        label: "Research date",
        type: "date",
        required: true,
      },
      { key: "tags", label: "Tags", type: "tags" },
    ],
  },
  {
    slug: "rfc",
    name: "RFC / Tech design",
    description:
      "Engineering proposal with context, options, recommendation, rollout, risks.",
    category: "engineering",
    body: rfcBody,
    properties: [
      { key: "owner", label: "Owner", type: "text", required: true },
      {
        key: "status",
        label: "Status",
        type: "select",
        options: ["draft", "in_review", "accepted", "rejected", "superseded"],
        default: "draft",
      },
      { key: "reviewers", label: "Reviewers", type: "tags" },
    ],
  },
  {
    slug: "postmortem",
    name: "Postmortem",
    description:
      "Incident review with timeline, impact, root cause, action items.",
    category: "engineering",
    body: postmortemBody,
    properties: [
      { key: "owner", label: "Incident owner", type: "text", required: true },
      {
        key: "severity",
        label: "Severity",
        type: "select",
        options: ["sev0", "sev1", "sev2", "sev3"],
        required: true,
      },
      {
        key: "incident_start",
        label: "Incident start",
        type: "datetime",
        required: true,
      },
      { key: "incident_end", label: "Incident end", type: "datetime" },
      { key: "tags", label: "Tags", type: "tags" },
    ],
  },
  {
    slug: "adr",
    name: "ADR (Architecture Decision Record)",
    description:
      "One-page architectural decision: context, decision, consequences.",
    category: "engineering",
    body: adrBody,
    properties: [
      {
        key: "number",
        label: "ADR number",
        type: "number",
        required: true,
        help: "Sequential ADR number for the project.",
      },
      {
        key: "status",
        label: "Status",
        type: "select",
        options: ["proposed", "accepted", "deprecated", "superseded"],
        default: "proposed",
      },
      { key: "deciders", label: "Deciders", type: "tags" },
    ],
  },
  {
    slug: "runbook",
    name: "Runbook",
    description:
      "Operational guide: symptoms, quick checks, mitigations, escalation.",
    category: "engineering",
    body: runbookBody,
    properties: [
      { key: "service", label: "Service", type: "text", required: true },
      { key: "owner_team", label: "Owner team", type: "text", required: true },
      {
        key: "severity_default",
        label: "Default severity",
        type: "select",
        options: ["sev1", "sev2", "sev3"],
        default: "sev2",
      },
    ],
  },
  {
    slug: "launch-plan",
    name: "Launch plan",
    description:
      "End-to-end launch plan: narrative, audience, channels, schedule.",
    category: "marketing",
    body: launchBody,
    properties: [
      { key: "owner", label: "Owner", type: "text", required: true },
      {
        key: "launch_date",
        label: "Launch date",
        type: "date",
        required: true,
      },
      {
        key: "tier",
        label: "Tier",
        type: "select",
        options: ["tier_1", "tier_2", "tier_3"],
        default: "tier_2",
        help: "How big a moment is this for the company?",
      },
    ],
  },
  {
    slug: "campaign-brief",
    name: "Campaign brief",
    description:
      "Marketing campaign brief: objective, audience, message, KPIs, budget.",
    category: "marketing",
    body: campaignBody,
    properties: [
      { key: "owner", label: "Owner", type: "text", required: true },
      { key: "start_date", label: "Start date", type: "date", required: true },
      { key: "end_date", label: "End date", type: "date" },
      { key: "budget_usd", label: "Budget (USD)", type: "number" },
      { key: "channels", label: "Channels", type: "tags" },
    ],
  },
  {
    slug: "one-pager",
    name: "Executive one-pager",
    description:
      "Exec-readable pitch: problem, plan, asks, timeline, risks — one page.",
    category: "business",
    body: onePagerBody,
    properties: [
      { key: "owner", label: "Owner", type: "text", required: true },
      {
        key: "for_audience",
        label: "For",
        type: "text",
        help: "Who is this written for? Exec name or function.",
      },
      {
        key: "quarter",
        label: "Quarter",
        type: "text",
        help: "Target quarter, e.g. 2026 Q3.",
      },
    ],
  },
  {
    slug: "meeting-notes",
    name: "Meeting notes",
    description: "Meeting record: attendees, agenda, decisions, action items.",
    category: "business",
    body: meetingBody,
    properties: [
      {
        key: "meeting_date",
        label: "Meeting date",
        type: "datetime",
        required: true,
      },
      {
        key: "meeting_type",
        label: "Meeting type",
        type: "select",
        options: ["sync", "decision", "review", "planning", "interview"],
        default: "sync",
      },
      { key: "facilitator", label: "Facilitator", type: "text" },
      { key: "tags", label: "Tags", type: "tags" },
    ],
  },
  {
    slug: "weekly-update",
    name: "Weekly update",
    description: "Team weekly: shipped, in flight, blocked, next week.",
    category: "business",
    body: weeklyBody,
    properties: [
      { key: "team", label: "Team", type: "text", required: true },
      { key: "week_of", label: "Week of", type: "date", required: true },
      { key: "author", label: "Author", type: "text" },
    ],
  },
  {
    slug: "one-on-one",
    name: "1:1 agenda",
    description:
      "Manager/report 1:1: recurring topics, this week, parking lot, actions.",
    category: "work",
    body: oneOnOneBody,
    properties: [
      { key: "manager", label: "Manager", type: "text", required: true },
      { key: "report", label: "Report", type: "text", required: true },
      { key: "meeting_date", label: "Meeting date", type: "date" },
    ],
  },
  {
    slug: "project-kickoff",
    name: "Project kickoff",
    description:
      "New project kickoff: scope, team, milestones, risks, communication.",
    category: "work",
    body: kickoffBody,
    properties: [
      {
        key: "project_lead",
        label: "Project lead",
        type: "text",
        required: true,
      },
      { key: "start_date", label: "Start date", type: "date", required: true },
      { key: "target_end", label: "Target end", type: "date" },
      { key: "stakeholders", label: "Stakeholders", type: "tags" },
    ],
  },
  {
    slug: "retrospective",
    name: "Retrospective",
    description: "Sprint or project retro: went well, didn't, try next.",
    category: "work",
    body: retroBody,
    properties: [
      {
        key: "facilitator",
        label: "Facilitator",
        type: "text",
        required: true,
      },
      {
        key: "retro_date",
        label: "Retro date",
        type: "date",
        required: true,
      },
      { key: "team", label: "Team", type: "text" },
    ],
  },
];

export function listBuiltinTemplates(): BuiltinTemplateSpec[] {
  return builtinTemplates;
}
