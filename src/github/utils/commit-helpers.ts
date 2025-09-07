import { execFileSync } from "child_process";

/**
 * Gets commits since a specific SHA using git log
 *
 * @param baseSha - The SHA to get commits since
 * @returns Array of commit objects with SHA and message
 */
export function getCommitsSinceSha(baseSha: string): Array<{
  oid: string;
  message: string;
}> {
  try {
    // Use git log to get commits since the base SHA
    const output = execFileSync(
      "git",
      ["log", `${baseSha}..HEAD`, "--oneline", "--no-merges", "--max-count=20"],
      {
        encoding: "utf-8",
      },
    ).trim();

    if (!output) {
      return [];
    }

    return output
      .split("\n")
      .map((line) => {
        const match = line.match(/^([a-f0-9]{7,}) (.+)$/);
        if (match) {
          return {
            oid: match[1],
            message: match[2],
          };
        }
        return null;
      })
      .filter(
        (commit): commit is { oid: string; message: string } => commit !== null,
      );
  } catch (error) {
    console.warn(`Failed to get commits since ${baseSha}:`, error);
    return [];
  }
}

/**
 * Gets the list of changed files between two SHAs
 *
 * @param baseSha - The base SHA to compare from
 * @param targetSha - The target SHA to compare to (defaults to HEAD)
 * @returns Array of changed file paths
 */
export function getChangedFilesSinceSha(
  baseSha: string,
  targetSha: string = "HEAD",
): string[] {
  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", `${baseSha}..${targetSha}`],
      {
        encoding: "utf-8",
      },
    ).trim();

    if (!output) {
      return [];
    }

    return output.split("\n").filter((file) => file.trim());
  } catch (error) {
    console.warn(`Failed to get changed files since ${baseSha}:`, error);
    return [];
  }
}

/**
 * Checks if a SHA exists in the current repository
 *
 * @param sha - The SHA to check
 * @returns True if the SHA exists
 */
export function shaExists(sha: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", sha], {
      stdio: "pipe",
    });
    return true;
  } catch (error) {
    return false;
  }
}
