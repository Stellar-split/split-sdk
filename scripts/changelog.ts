import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

type ChangeType = "feat" | "fix" | "chore" | "docs";

interface Commit {
  hash: string;
  subject: string;
  type: ChangeType;
  description: string;
}

interface VersionGroup {
  tag: string;
  commits: Commit[];
}

const TYPE_HEADINGS: Record<ChangeType, string> = {
  feat: "Features",
  fix: "Bug Fixes",
  chore: "Chores",
  docs: "Documentation",
};

const CONVENTIONAL_RE = /^(feat|fix|chore|docs)(?:\([^)]*\))?:\s+(.+)$/;

function getTags(): string[] {
  try {
    const out = execSync("git tag --sort=-version:refname", { encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function getCommits(from: string, to: string): Commit[] {
  const range = from ? `${from}..${to}` : to;
  const log = execSync(
    `git log ${range} --pretty=format:"%H|%s"`,
    { encoding: "utf8" }
  ).trim();

  if (!log) return [];

  return log
    .split("\n")
    .map((line) => {
      const pipeIdx = line.indexOf("|");
      const hash = line.slice(0, pipeIdx);
      const subject = line.slice(pipeIdx + 1);
      const match = CONVENTIONAL_RE.exec(subject);
      if (!match) return null;
      return {
        hash,
        subject,
        type: match[1] as ChangeType,
        description: match[2],
      };
    })
    .filter((c): c is Commit => c !== null);
}

function buildVersionGroups(): VersionGroup[] {
  const tags = getTags();
  const groups: VersionGroup[] = [];

  if (tags.length === 0) {
    // No tags — put everything under "Unreleased"
    const commits = getCommits("", "HEAD");
    if (commits.length) groups.push({ tag: "Unreleased", commits });
    return groups;
  }

  // Commits after the latest tag → Unreleased
  const unreleased = getCommits(tags[0], "HEAD");
  if (unreleased.length) groups.push({ tag: "Unreleased", commits: unreleased });

  // Each tag range
  for (let i = 0; i < tags.length; i++) {
    const to = tags[i];
    const from = tags[i + 1] ?? "";
    const commits = getCommits(from, to);
    if (commits.length) groups.push({ tag: to, commits });
  }

  return groups;
}

function renderGroup(group: VersionGroup): string {
  const byType = new Map<ChangeType, Commit[]>();
  for (const commit of group.commits) {
    const list = byType.get(commit.type) ?? [];
    list.push(commit);
    byType.set(commit.type, list);
  }

  const sections: string[] = [];
  for (const type of ["feat", "fix", "chore", "docs"] as ChangeType[]) {
    const commits = byType.get(type);
    if (!commits) continue;
    sections.push(`### ${TYPE_HEADINGS[type]}\n`);
    for (const c of commits) {
      sections.push(`- ${c.description} (\`${c.hash.slice(0, 7)}\`)`);
    }
    sections.push("");
  }

  return [`## ${group.tag}\n`, ...sections].join("\n");
}

function generate(): void {
  const groups = buildVersionGroups();
  const body = groups.map(renderGroup).join("\n");
  const content = `# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n${body}`;
  const outPath = resolve(process.cwd(), "CHANGELOG.md");
  writeFileSync(outPath, content, "utf8");
  console.log(`CHANGELOG.md written to ${outPath}`);
}

generate();
