/** Activity: every Change's events, grouped by Change, as timelines (agent steps under their Change). */
import { useApp } from "../lib/hooks.js";
import { formatTime } from "../lib/model.js";
import { proposalHref } from "../lib/router.js";
import { Card, EmptyState, Timeline, type IconName, type StateKind } from "../primitives/index.js";
import { Link, Loading } from "../ui.js";
import { activityLine, changeContext, groupActivity, type ActivityItem } from "./Changes.js";
import { useProject } from "./project-data.js";

const TONE_STATE: Record<ActivityItem["tone"], StateKind> = { plain: "neutral", decision: "decision", good: "ready", bad: "blocked" };

function iconOf(text: string): IconName {
  if (/restored/i.test(text)) return "versions";
  if (/agent/i.test(text)) return "agent";
  if (/^(You|The client|Client|Your developer|A developer|Developer|Owner|\S+@\S+)\b/.test(text) || /approved|accepted/i.test(text)) return "human";
  return "activity";
}

export function ActivityScreen() {
  const { org, pid, project, role, live } = useProject();
  const { me } = useApp();
  if (!live) return <Loading what="Loading activity" />;
  const now = new Date();
  const groups = groupActivity(changeContext(live, project, role), 50, 50, me?.user.userId);
  if (!groups.length)
    return (
      <EmptyState title="Nothing has happened yet." icon="activity">
        Imports, changes, approvals and releases are listed here as they happen.
      </EmptyState>
    );
  return (
    <div className="stack">
      {groups.map((g) => (
        <Card key={g.key} title={g.proposalId ? <Link href={proposalHref(org, pid, g.proposalId)}>{g.title}</Link> : g.title}>
          <Timeline label={`Activity: ${g.title}`} items={g.items.map((i) => ({ key: String(i.seq), title: activityLine(i), meta: formatTime(i.at, now), state: TONE_STATE[i.tone], icon: iconOf(i.text) }))} />
        </Card>
      ))}
    </div>
  );
}
