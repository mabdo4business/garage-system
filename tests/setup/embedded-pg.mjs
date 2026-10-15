// Runs an embedded PostgreSQL in its own process for the test run.
//
// Why a separate process: embedded-postgres installs process-exit hooks (async-exit-hook) that
// call process.exit(0) on "beforeExit". Inside the Vitest process that would turn a failing test
// run into exit code 0. Isolated here, the hooks only affect this helper.
//
// Usage: node tests/setup/embedded-pg.mjs <dataDir> <port>
// Prints one JSON line {"ready":true} when the server accepts connections.
// Stops the server when stdin closes (parent exited) or on SIGTERM.
import EmbeddedPostgres from "embedded-postgres";

const [dataDir, port] = process.argv.slice(2);
const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres",
  port: Number(port),
  persistent: false,
  onLog: () => {},
});

await server.initialise();
await server.start();
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.stop();
  process.exit(0);
};
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
process.stdin.resume();
