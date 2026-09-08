export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  author: string;
  date: string;
  image?: string;
}

/** Blog posts ordered newest-first. Keep in sync with pages/blog/*.mdx frontmatter. */
export const blogPosts: BlogPost[] = [
  {
    slug: 'why-disco-is-leaving-unix-impersonation-behind',
    title: 'Why Disco Is Leaving Unix Impersonation Behind',
    description:
      'We tried mapping Disco RBAC onto Unix users, groups, ACLs, and homes. It was an attractive design, but the wrong foundation for where Disco is going.',
    author: 'Maxime Beauchemin',
    date: '2026-08-17',
    image: '/images/blog/leaving-unix-impersonation.png',
  },
  {
    slug: 'whos-still-using-an-ide',
    title: 'Is the IDE Obsolete?',
    description:
      'The IDE was built around one human manipulating one codebase. Agentic software work now happens across parallel workstreams, conversations, and review surfaces.',
    author: 'Maxime Beauchemin',
    date: '2026-08-01',
    image: '/images/blog/whos-still-using-an-ide.png',
  },
  {
    slug: 'claude-tag-vs-disco-assistants',
    title: 'Claude Tag Validates the Category. Now Model Your Teammates.',
    description:
      'Claude Tag brings @Claude into Slack. Here is why teams will still need modeled, governed, observable, multi-specialist teammates — and why Disco is built for that next step.',
    author: 'Maxime Beauchemin',
    date: '2026-06-26',
    image: '/images/blog/claude-tag-vs-disco-teammates.png',
  },
  {
    slug: 'raise-team-helper-agent',
    title: 'Raise a Team Helper Agent in an Afternoon',
    description:
      'A practical recipe for turning an AI teammate into a PM-style helper that remembers context, coordinates work, reports progress, and keeps a team aligned.',
    author: 'Maxime Beauchemin',
    date: '2026-06-17',
    image: '/images/blog/raise-team-helper-agent.png',
  },
  {
    slug: 'agent-modeling-101',
    title: 'Agent Modeling 101: Designing Long-Lived Agents for Teams',
    description:
      'High-level considerations for scoping, operating, governing, and building trust with persistent agents that help teams manage real workflows.',
    author: 'Maxime Beauchemin',
    date: '2026-06-15',
    image: '/images/blog/agent-modeling-101.png',
  },
  {
    slug: 'disco-assistants',
    title: 'Introducing Disco Teammates',
    description:
      'What started as an OpenClaw experiment is now a first-class Disco feature. Meet Teammates — persistent AI entities with memory, skills, and team-wide reach through Slack.',
    author: 'Maxime Beauchemin',
    date: '2026-03-03',
    image: '/images/blog/disco-teammates.png',
  },
  {
    slug: 'disco-openclaw',
    title: 'Disco-OpenClaw: OpenClaw Patterns Running 100% Inside Disco',
    description:
      'I recreated the OpenClaw agent framework to run entirely within Disco — persistent agents with full visibility, introspection, and multi-agent coordination on a spatial canvas.',
    author: 'Maxime Beauchemin',
    date: '2026-02-04',
    image: '/images/blog/disco-openclaw.png',
  },
  {
    slug: 'openclaw',
    title: 'Disco vs. OpenClaw (ClawdBot): Thoughts on Agent Orchestration',
    description:
      'What the fastest-growing open-source project teaches us about agentic AI, and how Disco brings similar capabilities to developer workflows.',
    author: 'Maxime Beauchemin',
    date: '2026-02-03',
    image: '/images/blog/openclaw-comparison.png',
  },
  {
    slug: 'disco-cloud',
    title: 'Disco Cloud — Opening a Private Beta',
    description:
      'Fully managed Disco with tenant-scoped execution isolation, analytics dashboards, policy controls, and enterprise observability.',
    author: 'Maxime Beauchemin',
    date: '2025-11-23',
    image: '/images/blog/disco-cloud.png',
  },
  {
    slug: 'disco-platform',
    title: 'More Than a GUI: Disco is a Full Platform to Orchestrate AI Agents',
    description:
      "Disco's rich GUI sits atop a fully-typed REST API, powerful CLI, and TypeScript client enabling git branch management, agent orchestration from CI/CD, and custom workflows.",
    author: 'Maxime Beauchemin',
    date: '2025-11-16',
    image: '/images/blog/disco-platform.png',
  },
  {
    slug: 'orchestration-layers',
    title: 'The Future of Software Engineering is Agent Orchestration',
    description:
      'Software development evolved from copy-pasting prompts to orchestrating multiple AI agents. Here is how we got here and what comes next.',
    author: 'Maxime Beauchemin',
    date: '2025-11-15',
    image: '/images/blog/orchestration-layers.png',
  },
  {
    slug: 'context-engineering',
    title: 'Context Engineering the @mistercrunch Way',
    description:
      'Keep AI context maintainable: bite-sized md nuggets in a context/ folder, cross-linked and treated like code.',
    author: 'Maxime Beauchemin',
    date: '2025-10-29',
    image: '/images/blog/context-engineering.png',
  },
  {
    slug: 'announcement',
    title: 'Disco: A Multiplayer-ready, Spatial Layer for Agentic Coding',
    description:
      'Agent orchestration across Claude Code, Codex, and Gemini on a real-time spatial board with session trees, zone triggers, and per-branch environments.',
    author: 'Maxime Beauchemin',
    date: '2025-10-26',
    image: '/images/blog/announcement.png',
  },
  {
    slug: 'making-of-disco',
    title: 'The Making of Disco',
    description:
      'Behind the scenes of building Disco — from solving session context loss to creating a multiplayer platform for AI agent orchestration.',
    author: 'Maxime Beauchemin',
    date: '2025-10-25',
    image: '/images/blog/making-of-disco.png',
  },
];
