/**
 * GitHub API Integration for Verify Action
 * ==========================================
 *
 * Reads PR data (diff, metadata) and posts comments.
 * Uses the GitHub REST API via fetch — no @actions/github dependency.
 */

export interface PRMetadata {
  title: string;
  body: string;
  number: number;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  issueTitle?: string;
  commitMessages: string[];
}

/**
 * Get the PR diff as a unified diff string.
 */
export async function getPRDiff(token: string, owner: string, repo: string, prNumber: number): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3.diff',
    },
  });
  if (!res.ok) throw new Error(`Failed to get PR diff: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Get PR metadata (title, body, commits, linked issue).
 */
export async function getPRMetadata(token: string, owner: string, repo: string, prNumber: number): Promise<PRMetadata> {
  // Get PR details
  const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!prRes.ok) throw new Error(`Failed to get PR: ${prRes.status}`);
  const pr = await prRes.json() as any;

  // Get commit messages
  const commitsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=50`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  const commits = commitsRes.ok ? (await commitsRes.json() as any[]) : [];
  const commitMessages = commits.map((c: any) => c.commit?.message ?? '').filter(Boolean);

  // Try to find linked issue from PR body (matches #123 or org/repo#123)
  let issueTitle: string | undefined;
  const issueMatch = pr.body?.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
  if (issueMatch) {
    try {
      const issueRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueMatch[1]}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
      });
      if (issueRes.ok) {
        const issue = await issueRes.json() as any;
        issueTitle = issue.title;
      }
    } catch { /* issue fetch failed — not critical */ }
  }

  return {
    title: pr.title ?? '',
    body: pr.body ?? '',
    number: prNumber,
    headSha: pr.head?.sha ?? '',
    baseBranch: pr.base?.ref ?? 'main',
    headBranch: pr.head?.ref ?? '',
    issueTitle,
    commitMessages,
  };
}

/**
 * Post a comment on a PR. Updates existing verify comment if found.
 */
export async function postPRComment(token: string, owner: string, repo: string, prNumber: number, body: string): Promise<void> {
  const marker = '<!-- verify-action -->';
  const fullBody = `${marker}\n${body}`;

  // Check for existing verify comment
  const commentsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
  });

  if (commentsRes.ok) {
    const comments = await commentsRes.json() as any[];
    const existing = comments.find((c: any) => c.body?.includes(marker));

    if (existing) {
      // Update existing comment
      await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: fullBody }),
      });
      return;
    }
  }

  // Create new comment
  await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body: fullBody }),
  });
}
