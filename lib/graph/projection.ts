// Projects one repository's relational data into Neo4j for graph queries.
// PostgreSQL stays the source of truth; this graph can always be rebuilt from it.
//
//   (:Repository)<-[:IN_REPO]-(:Developer)-[:TOUCHED {commits, churn}]->(:File)-[:IN_REPO]->(:Repository)
//   (:Developer)-[:OWNS {lines}]->(:File)
//   (:File)-[:COUPLED_WITH {cochanges, jaccard}]-(:File)

import type { Pool } from "pg";
import type { Driver } from "neo4j-driver";

const BATCH = 1000;

async function run(driver: Driver, text: string, params: Record<string, unknown> = {}) {
  const session = driver.session();
  try {
    await session.executeWrite((tx) => tx.run(text, params));
  } finally {
    await session.close();
  }
}

async function unwind(driver: Driver, text: string, rows: unknown[], extra: Record<string, unknown> = {}) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await run(driver, text, { ...extra, rows: rows.slice(i, i + BATCH) });
  }
}

export async function projectRepository(pool: Pool, driver: Driver, repoId: number): Promise<void> {
  const repo = (await pool.query("SELECT id, name FROM repositories WHERE id = $1", [repoId])).rows[0];
  if (!repo) return;

  // Remove the previous projection in batches so large graphs do not blow the transaction size.
  for (;;) {
    const session = driver.session();
    try {
      const res = await session.executeWrite((tx) =>
        tx.run(
          `MATCH (n) WHERE (n:Developer OR n:File) AND n.repoId = $repoId
           WITH n LIMIT 5000 DETACH DELETE n RETURN count(*) AS deleted`,
          { repoId },
        ),
      );
      if (Number(res.records[0]?.get("deleted") ?? 0) === 0) break;
    } finally {
      await session.close();
    }
  }

  await run(driver, "MERGE (r:Repository {id: $repoId}) SET r.name = $name", { repoId, name: repo.name });

  const devs = (await pool.query(
    "SELECT id::int, name, email FROM developers WHERE repository_id = $1", [repoId],
  )).rows;
  await unwind(driver,
    `MATCH (r:Repository {id: $repoId})
     UNWIND $rows AS row
     CREATE (d:Developer {id: row.id, repoId: $repoId, name: row.name, email: row.email})-[:IN_REPO]->(r)`,
    devs, { repoId });

  const files = (await pool.query(
    "SELECT id::int, path, exists_at_head AS alive FROM files WHERE repository_id = $1", [repoId],
  )).rows;
  await unwind(driver,
    `MATCH (r:Repository {id: $repoId})
     UNWIND $rows AS row
     CREATE (f:File {id: row.id, repoId: $repoId, path: row.path, alive: row.alive})-[:IN_REPO]->(r)`,
    files, { repoId });

  const touched = (await pool.query(
    `SELECT c.author_id::int AS dev, fc.file_id::int AS file,
            count(*)::int AS commits,
            COALESCE(sum(fc.insertions + fc.deletions), 0)::int AS churn
     FROM commits c JOIN file_changes fc ON fc.commit_id = c.id
     WHERE c.repository_id = $1
     GROUP BY 1, 2`, [repoId],
  )).rows;
  await unwind(driver,
    `UNWIND $rows AS row
     MATCH (d:Developer {id: row.dev}), (f:File {id: row.file})
     CREATE (d)-[:TOUCHED {commits: row.commits, churn: row.churn}]->(f)`,
    touched);

  const owns = (await pool.query(
    `SELECT o.developer_id::int AS dev, o.file_id::int AS file, o.lines
     FROM file_ownership o JOIN files f ON f.id = o.file_id
     WHERE f.repository_id = $1`, [repoId],
  )).rows;
  await unwind(driver,
    `UNWIND $rows AS row
     MATCH (d:Developer {id: row.dev}), (f:File {id: row.file})
     CREATE (d)-[:OWNS {lines: row.lines}]->(f)`,
    owns);

  const coupled = (await pool.query(
    `SELECT file_a_id::int AS a, file_b_id::int AS b, cochanges, jaccard
     FROM coupling_edges WHERE repository_id = $1`, [repoId],
  )).rows;
  await unwind(driver,
    `UNWIND $rows AS row
     MATCH (a:File {id: row.a}), (b:File {id: row.b})
     CREATE (a)-[:COUPLED_WITH {cochanges: row.cochanges, jaccard: row.jaccard}]->(b)`,
    coupled);
}

/** Uniqueness constraints and indexes; safe to run repeatedly. */
export async function initGraphSchema(driver: Driver): Promise<void> {
  for (const stmt of [
    "CREATE CONSTRAINT repository_id IF NOT EXISTS FOR (r:Repository) REQUIRE r.id IS UNIQUE",
    "CREATE CONSTRAINT developer_id IF NOT EXISTS FOR (d:Developer) REQUIRE d.id IS UNIQUE",
    "CREATE CONSTRAINT file_id IF NOT EXISTS FOR (f:File) REQUIRE f.id IS UNIQUE",
    "CREATE INDEX developer_repo IF NOT EXISTS FOR (d:Developer) ON (d.repoId)",
    "CREATE INDEX file_repo IF NOT EXISTS FOR (f:File) ON (f.repoId)",
  ]) {
    await run(driver, stmt);
  }
}

export async function deleteRepositoryGraph(driver: Driver, repoId: number): Promise<void> {
  await run(driver,
    `MATCH (n) WHERE (n:Developer OR n:File) AND n.repoId = $repoId DETACH DELETE n`, { repoId });
  await run(driver, "MATCH (r:Repository {id: $repoId}) DETACH DELETE r", { repoId });
}
