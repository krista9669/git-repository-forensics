// Creates fixtures/repos/demo, a small repository you can register as the
// local repository "demo" to try the app without network access.
import "./load-env";
import path from "node:path";
import { createFixtureRepo } from "./fixture-repo";

const root = process.env.LOCAL_REPO_ROOT ?? "./fixtures/repos";
const dir = path.resolve(root, "demo");
createFixtureRepo(dir);
console.log(`Created demo repository at ${dir}`);
console.log('Register it in the app as a local repository with the folder name "demo".');
