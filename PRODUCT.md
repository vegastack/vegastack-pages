# Product

## Register

product

## Users

Software teams building an agent-maintained knowledge base. Two recurring contexts:

- An agent creates or edits Markdown, MDX, or HTML through MCP or the `vpg` CLI, often from a workspace template.
- A human reviews the rendered page, leaves anchored comments, and expects the agent to make precise follow-up edits.

Both contexts happen in normal working conditions: desktop primary, occasional tablet, dim/bright office light, focused but interruption-prone. Output is reviewed before shipping; review velocity and clarity matter as much as authoring speed.

## Product Purpose

VegaStack Pages is an open-source Agentic Knowledge Base. Agents create structured pages, humans review them in the browser, and agents act on that feedback without losing source history. Templates make recurring outputs consistent. MCP and CLI make the workflow scriptable. Backup to Git keeps the knowledge base portable.

## Brand Personality

Calm, technical, expert. Three words: precise, unhurried, legible. The interface should feel like a senior reviewer would have designed it: confident defaults, no cheerleading, no consumer-app gloss. Joy is earned through clarity, not decoration.

## Anti-references

- Generic SaaS dashboards with hero metric cards, gradient accents, and same-size card grids.
- Developer-tool aesthetics that lean on neon-on-black, terminal mimicry, or aggressive monospace.
- Consumer-warm doc tools that infantilize the reviewer with emoji-heavy empty states and confetti.
- GitHub-PR-style review surfaces where every comment is a transactional event with avatars and timestamps stamped on top.

## Design Principles

- **Comments are conversation, not bureaucracy.** Threads read like a paragraph of dialogue, not a ticket trail. Selected text is always visible as the anchor of the conversation.
- **Humans and agents are equal citizens, visibly distinct.** An agent reply must be unmistakable without being demoted. Distinct accent + badge, never a watered-down clone.
- **The document is the surface; everything else is auxiliary.** Toolbars, panels, and comments cede space and weight to the prose being reviewed.
- **Standard practices over invented patterns.** When Notion and Google Docs already converged on a behavior (selection popover, floating threads, click-highlight-to-focus), match it. Reserve novelty for areas they haven't solved.
- **Respect the reviewer's attention.** Motion is short, ease-out, and only signals state changes. Color stays restrained; one accent does the work of ten.

## Accessibility & Inclusion

- WCAG 2.2 AA is the floor for color contrast, focus visibility, and keyboard reachability.
- Resolved/unresolved and human/agent state must be conveyed through more than color (icon, label, position).
- Reduced-motion preference disables every comment animation (highlight pulse, card slide).
- All comment affordances reachable via keyboard: open from highlight, navigate threads, reply, resolve.
