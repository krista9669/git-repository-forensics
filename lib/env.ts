import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === undefined || v.toLowerCase() !== "false");

const int = (def: number) =>
  z.coerce.number().int().positive().default(def);

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  TEST_DATABASE_URL: z.string().optional(),
  NEO4J_URI: z.string().default("bolt://localhost:7687"),
  NEO4J_USER: z.string().default("neo4j"),
  NEO4J_PASSWORD: z.string().default(""),
  REDIS_URL: z.string().default("redis://localhost:6380/0"),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  ALLOW_SELF_REGISTRATION: bool,
  SESSION_TTL_HOURS: int(12),
  ALLOWED_GIT_HOSTS: z
    .string()
    .default("github.com,gitlab.com,bitbucket.org,codeberg.org")
    .transform((s) =>
      s.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    ),
  LOCAL_REPO_ROOT: z.string().default("./fixtures/repos"),
  WORKSPACE_DIR: z.string().default("./.workspaces"),
  COUPLING_MAX_FILES_PER_COMMIT: int(30),
  COUPLING_MIN_COCHANGE: int(2),
  ANALYSIS_MAX_COMMITS: int(50000),
  GIT_CLONE_TIMEOUT_MS: int(600000),
  BLAME_MAX_FILES: int(150),
  HUNK_MAX_COMMITS: int(3000),
  WORKER_POLL_INTERVAL_MS: int(3000),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parsed, validated environment. Throws once with every problem listed. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
