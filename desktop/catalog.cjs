const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

async function catalog(client, codexHome) {
  const projects = [];
  let cursor = null;
  do {
    const page = await client.request("project/list", { cursor });
    projects.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  const threads = new Map();
  do {
    const page = await client.request("thread/list", {
      cursor,
      limit: 100,
      useStateDbOnly: true,
      modelProviders: [],
    });
    for (const thread of page.data) threads.set(thread.id, thread);
    cursor = page.nextCursor;
  } while (cursor);
  // Desktop 0.153.4 still keeps some legacy memberships outside the thread database.
  const desktop = JSON.parse(
    await readFile(join(codexHome, ".codex-global-state.json"), "utf8"),
  );
  const idMap =
    desktop["app-server-project-id-by-legacy-project-id-by-host"][
      `local:${codexHome}`
    ];
  const assignments = desktop["thread-project-assignments"];
  for (const thread of threads.values()) {
    if (thread.projectId === null && Object.hasOwn(assignments, thread.id)) {
      thread.projectId = idMap[assignments[thread.id].projectId];
      thread.membershipSource = "desktop-assignment";
    } else {
      thread.membershipSource = "app-server";
    }
  }
  const models = await client.request("model/list", {});
  return {
    projects,
    threads: [...threads.values()],
    models: models.data.filter((model) => !model.hidden),
  };
}
module.exports = { catalog };
