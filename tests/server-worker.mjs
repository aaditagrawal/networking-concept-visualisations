// Run with Node so integration tests use the shipped runtime's filesystem APIs.
const { startServer } = await import(process.argv[2]);
const server = await startServer({ hostname: '127.0.0.1', port: 0 });
console.log(JSON.stringify({ port: server.port }));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void server.stop().then(() => process.exit(0)); });
}
