import neo4j, { type Driver } from "neo4j-driver";
import { env } from "./env";

const g = globalThis as unknown as { __grfNeo4j?: Driver };

export function neo4jDriver(): Driver {
  if (!g.__grfNeo4j) {
    const e = env();
    g.__grfNeo4j = neo4j.driver(
      e.NEO4J_URI,
      neo4j.auth.basic(e.NEO4J_USER, e.NEO4J_PASSWORD),
      { disableLosslessIntegers: true },
    );
  }
  return g.__grfNeo4j;
}

export async function cypher<T = Record<string, unknown>>(
  text: string,
  params: Record<string, unknown> = {},
  mode: "READ" | "WRITE" = "READ",
): Promise<T[]> {
  const session = neo4jDriver().session({
    defaultAccessMode: mode === "READ" ? neo4j.session.READ : neo4j.session.WRITE,
  });
  try {
    const res = await session.run(text, params);
    return res.records.map((r) => r.toObject() as T);
  } finally {
    await session.close();
  }
}
