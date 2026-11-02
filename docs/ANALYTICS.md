# Repository Analytics

## 1. Overview

Git Repository Forensics converts raw Git history into metrics that help teams understand code ownership, maintenance risk, file relationships, and developer collaboration.

This document describes the analytical concepts and calculations used by the project.

## 2. Data Collected

The analysis pipeline collects:

- Commit metadata and commit messages.
- Commit authors and timestamps.
- Files modified by each commit.
- Changed-line ranges.
- Current line ownership from `git blame`.

Commits and file changes form the historical basis for the analytical calculations.

## 3. Change Coupling

Change coupling identifies files that are frequently modified together.

Let:

- `n(A)` be the number of commits that modify file A.
- `n(B)` be the number of commits that modify file B.
- `n(A,B)` be the number of commits that modify both A and B.

The project counts file pairs that appear in the same commit. Commits touching more than 30 files are skipped during pair counting to avoid unusually large commits dominating the pair calculation.

### 3.1 Co-change Count

```text
CoChanges(A,B) = n(A,B)
```

This is the number of commits in which both files were modified.

### 3.2 Directional Confidence

```text
Confidence(A → B) = n(A,B) / n(A)
Confidence(B → A) = n(A,B) / n(B)
```

Confidence is directional. If A changes frequently and B changes in most of those commits, confidence from A to B will be high.

### 3.3 Jaccard Similarity

```text
Jaccard(A,B) = n(A,B) / (n(A) + n(B) - n(A,B))
```

Jaccard similarity measures the overlap between the two files' commit histories.

Its value ranges from 0 to 1:

- `0` means no shared commits.
- `1` means the files have identical sets of modifying commits.

### 3.4 Worked Example

Suppose:

- File A changes in commits 1, 2, 4, 5, and 6.
- File B changes in commits 1, 2, and 4.

Then:

```text
n(A)   = 5
n(B)   = 3
n(A,B) = 3

Jaccard(A,B) = 3 / (5 + 3 - 3)
             = 3 / 5
             = 0.6
```

The files have a Jaccard similarity of `0.6`.

## 4. Code Hotspot Analysis

A hotspot is a file that has experienced substantial modification activity.

The documented `file_hotspots` view uses:

- **Revisions:** Number of changes to the file.
- **Authors:** Number of distinct developers who changed it.
- **Churn:** Amount of code added and removed.

Files with high revision counts, many authors, and high churn may deserve additional review because they are frequently changing areas of the codebase.

The hotspot metric is a prioritization signal, not proof that a file contains defects.

Example:

```sql
SELECT path, revisions, authors, churn
FROM file_hotspots
WHERE repository_id = 2
ORDER BY revisions DESC
LIMIT 10;
```

## 5. Code Ownership

The system uses `git blame` to determine who is associated with the current lines of a file.

Ownership records are stored in `file_ownership` and represent line ownership at the current repository state.

Ownership is useful for:

- Finding developers familiar with a file.
- Identifying knowledge concentration.
- Supporting reviewer recommendations.
- Calculating the bus factor.

Ownership should not be interpreted as a perfect measure of expertise. It is a historical attribution signal.

## 6. Bus Factor

The bus factor estimates the minimum number of developers who collectively own more than half of the currently owned lines.

The calculation:

1. Retrieves line ownership by developer.
2. Sorts developers by lines owned, in descending order.
3. Computes cumulative ownership using a window function.
4. Finds the smallest number of developers whose combined ownership exceeds 50%.

Illustrative SQL window calculation:

```sql
SUM(lines_owned) OVER (
    ORDER BY lines_owned DESC
)
```

The project exposes the calculation through:

```sql
SELECT bus_factor(2);
```

A low bus factor indicates that a relatively small number of developers account for a large share of current line ownership.

## 7. Team Analytics

Team analytics uses SQL aggregation to identify contribution patterns.

### 7.1 Core Contributors

The system compares each developer's commit count with the average commit count across developers.

The query uses:

- `GROUP BY` to count commits per author.
- A subquery to calculate the average.
- `HAVING` to retain developers at or above the average.

```sql
SELECT d.name, COUNT(*) AS commits
FROM commits c
JOIN developers d ON d.id = c.author_id
WHERE c.repository_id = 2
GROUP BY d.name
HAVING COUNT(*) >= (
    SELECT AVG(n)
    FROM (
        SELECT COUNT(*) AS n
        FROM commits
        WHERE repository_id = 2
        GROUP BY author_id
    ) per_dev
)
ORDER BY commits DESC;
```

Add `AND NOT d.is_bot` to the outer WHERE clause when the report should exclude detected bots. The inner average should use the same population if the intended comparison is among human contributors only.

### 7.2 Shared Files

Shared files are files modified by multiple developers. The number of distinct authors can be grouped by file and filtered with `HAVING`.

```sql
SELECT f.path,
       COUNT(DISTINCT c.author_id) AS authors
FROM file_changes fc
JOIN files f ON f.id = fc.file_id
JOIN commits c ON c.id = fc.commit_id
WHERE c.repository_id = 2
GROUP BY f.path
HAVING COUNT(DISTINCT c.author_id) >= 2
ORDER BY authors DESC;
```

## 8. Reviewer Recommendations

The project creates a graph projection in Neo4j.

The graph represents:

- Developers.
- Files.
- Developer-to-file `TOUCHED` relationships.
- File-to-file `COUPLED_WITH` relationships.

A reviewer can be suggested by traversing from files involved in a change to developers who have touched those files or strongly coupled files.

The graph is rebuilt from PostgreSQL after analysis. PostgreSQL remains the source of truth.

Example graph query:

```cypher
MATCH (d:Developer {repoId: 2})-[t:TOUCHED]->(f:File)
WHERE t.commits >= 5
RETURN d, t, f;
```

Example coupled-file query:

```cypher
MATCH (a:File {repoId: 2})-[c:COUPLED_WITH]-(b:File)
WHERE c.jaccard >= 0.3
RETURN a, c, b;
```

## 9. Commit Search

### 9.1 Full-text Search

PostgreSQL full-text search indexes commit subjects and bodies using a GIN index.

It supports keyword-based retrieval, such as searching for commits containing `preflight`.

### 9.2 Vector Similarity Search

Commit messages are represented as 256-dimensional vectors and stored using pgvector.

The project uses feature hashing over words and word pairs. Similarity search retrieves messages with overlapping hashed features.

**Important limitation:** This representation is not a full semantic language model. Messages with different wording but equivalent meaning may not be recognized as similar.

## 10. Interpretation and Limitations

Analytics results should be interpreted as signals rather than definitive judgments.

- A hotspot is not necessarily defective code.
- High coupling does not prove a direct source-code dependency.
- Git blame ownership is not a complete measure of expertise.
- Commit counts do not measure contribution quality.
- Email-based identities may split one person into multiple developer records.
- All-history metrics may overemphasize old activity.

Potential improvements include time-windowed metrics, identity merging, stronger semantic embeddings, and incremental analysis.
