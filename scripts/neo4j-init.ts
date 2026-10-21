// Creates Neo4j constraints and indexes. Safe to run more than once.
import "./load-env";
import { neo4jDriver } from "../lib/neo4j";
import { initGraphSchema } from "../lib/graph/projection";

const driver = neo4jDriver();
initGraphSchema(driver)
  .then(() => console.log("Neo4j constraints and indexes are in place."))
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => driver.close());
