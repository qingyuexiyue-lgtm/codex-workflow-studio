import { createRequire } from "node:module";
import { writeFile, mkdir } from "node:fs/promises";
const require = createRequire(import.meta.url);
const { CodexClient } = require("../desktop/codex-client.cjs");
const client = new CodexClient("codex");
const report = {};
try {
  report.server = await client.initialize();
  for (const [method, params] of [
    ["project/list", {}],
    ["thread/list", { limit: 5, sourceKinds: [], sortKey: "updated_at" }],
    ["model/list", {}],
    ["thread/loaded/list", {}],
  ]) {
    try {
      report[method] = await client.request(method, params);
      console.log(method, JSON.stringify(report[method]).slice(0, 9000));
    } catch (error) {
      report[method] = { error: error.message };
      console.log(error.message);
    }
  }
  await mkdir(".integration", { recursive: true });
  await writeFile(".integration/probe.json", JSON.stringify(report, null, 2));
} finally {
  client.close();
}
