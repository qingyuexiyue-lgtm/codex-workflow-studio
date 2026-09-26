const { DatabaseSync } = require("node:sqlite");
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");

class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.directory = directory;
    this.db = new DatabaseSync(join(directory, "studio.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL);",
    );
  }
  workflows() {
    return this.db
      .prepare("SELECT body FROM workflows ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(row.body));
  }
  saveWorkflow(workflow) {
    this.db
      .prepare(
        "INSERT INTO workflows VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(workflow.id, JSON.stringify(workflow));
    return workflow;
  }
  deleteWorkflow(id) {
    this.db.prepare("DELETE FROM workflows WHERE id=?").run(id);
  }
  runs() {
    return this.db
      .prepare("SELECT body FROM runs ORDER BY rowid DESC")
      .all()
      .map((row) => JSON.parse(row.body));
  }
  saveRun(run) {
    this.db
      .prepare(
        "INSERT INTO runs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(run.id, JSON.stringify(run));
  }
  close() {
    this.db.close();
  }
}
module.exports = { Store };
