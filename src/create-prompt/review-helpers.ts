// Helper function to find the last review from a specific user
export function findLastReviewFromUser(
  reviewData: {
    nodes: Array<{
      author: { login: string };
      submittedAt: string;
      id: string;
    }>;
  } | null,
  username: string,
): { submittedAt: string; id: string } | null {
  if (!reviewData?.nodes || reviewData.nodes.length === 0) {
    return null;
  }

  // Filter reviews by the specific user and sort by submission time (newest first)
  const userReviews = reviewData.nodes
    .filter((review) => review.author.login === username)
    .sort(
      (a, b) =>
        new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime(),
    );

  const latestReview = userReviews[0];
  if (!latestReview) {
    return null;
  }

  // Return only the subset of fields specified in the function signature
  return {
    submittedAt: latestReview.submittedAt,
    id: latestReview.id,
  };
}

// Helper function to get commits since a specific date
export function getCommitsSinceReview(
  commits: Array<{
    commit: {
      oid: string;
      message: string;
      author: { name: string; email: string };
    };
  }>,
  _reviewDate: string,
): Array<{
  oid: string;
  message: string;
  author: { name: string; email: string };
}> {
  // Note: This is a simplified approach as commit timestamps might not perfectly align with review times
  // Since we don't have commit timestamps in the current data structure,
  // we'll return all commits and let Claude understand the context
  // In a future enhancement, we could use git log to get more precise timing
  return commits.map((c) => c.commit);
}
