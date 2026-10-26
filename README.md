# AP Labs

**A starter template for building AI platforms inside client companies.**

## Why this exists

Many companies want AI in their day-to-day work but don't know where to start. The usual move is to hand out AI licences and let people figure it out, and it rarely sticks.

AP Labs is a consulting practice that does it differently:

1. **Deep dive** on the company: how it works and where the pain is.
2. **Pick starter problems** the company wants AI to handle.
3. **Build the solution:** an AI platform with tools that solve those problems, living where people already work (for example Slack).
4. **Train their builders** so the company keeps building on it after we leave.

Every company is different, so we don't sell one product. Instead we start every engagement from this template, so we never rebuild the basics from scratch.

The template is a generalised version of an AI platform we built for a reference client. One example of what it does: a sales rep opens a tool in Slack and asks in plain English for a list of contacts from the CRM. The tool scores them as leads and pushes the list to the email tool, so tools that didn't talk to each other now work as one. The reference client is a design reference only. None of its code, data or history is in this repo.

## What's in the template

**1. The app the client's employees use**
- A Slack bot with menus ("hubs"); each button opens a tool ("module")
- A fill-in-the-blanks way to add a new tool
- A standard way to connect to a client's systems (CRM, email tools, databases)
- Two ready-made tool types:
  - **Pull:** ask in plain English and get the right records back
  - **Push:** preview a list, approve it, and send it to another system
- The basics: who can see which tool, safe database queries, onboarding, feedback buttons

**2. The Orchestrator: how new tools get built** (by us, then by the client's builders)
- A lead agent plans the work with you, then routes it to specialist agents (data, guardrails, integrations, building, docs, checks)
- An onboarding agent learns each new client's data, systems and rules, so the specialists start out knowing them
- Plans are written as phases and PR-sized stories, and nothing is built until you approve
- Risky changes are noticed automatically, checks actually run, and a second AI model reviews every change
- All of it driven by one settings file per client, so every client's setup differs only in that file

**3. A fake company to build and demo on**
- **Brightside Home Cleaning:** made-up clients, cleaning visits and invoices, plus a pretend CRM and email tool. We can show the whole flow without touching anyone's real data.

## What "done" looks like

Copy the template and set it up for Brightside. Then, in Slack:

> Office manager: "Find recurring clients we haven't cleaned in 3 weeks."
> → the bot pulls them → scores them → shows a preview → she approves → the list goes to the email tool.

Adding the next tool means filling in a template, not rebuilding the plumbing.

## Where we are

| | Step | Status |
|---|---|---|
| 🟢 | Repo skeleton, the client settings file, permissions, change-risk scoring | Done |
| ⚪ | The Orchestrator: the build process every later step runs through ([design](docs/orchestrator/DESIGN.md)) | Next |
| ⚪ | A bare Slack app that starts up with one "hello" tool | |
| ⚪ | The fake company's data | |
| ⚪ | Connecting to the pretend CRM and email tool | |
| ⚪ | The "pull" tool | |
| ⚪ | The "push" tool (the demo works end to end) | |

The detailed plan, with every building block and where it comes from in the reference platform, is in [`docs/PLAN-v1.md`](docs/PLAN-v1.md).

---

## For builders

Start with [`AGENTS.md`](AGENTS.md); it holds the rules for people and coding agents working in this repo.

**Layout**
- `kit/`: the template's engine. Libraries in `kit/lib/`, Claude Code plugin in `kit/plugin/`, verify harness in `kit/verify/`.
- `profiles/`: client settings files and their schema (`profiles/brightside/` is the demo client).
- `examples/`, `test/`: the example install and the tests.
- `docs/PLAN-v1.md`: the build plan. `docs/adr/`: decisions. `docs/reference/`: the original design and research.

**Checks** (Node 24 or later; run `npm ci` once)

```
npm run check    # syntax: JS, shell, JSON
npm test         # unit tests
npm run verify   # verify harness
```
