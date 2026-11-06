# Networking Concept Visualisations

Just a few basic visualisations of networking concepts built with HTML/CSS/JS to aid with in-class teaching.

Use Node 24.22.1, pinned in `.node-version`, and run `bun run dev` to open http://localhost:3000. Set `PORT` and `HOST` to change the listener, which defaults to `0.0.0.0:3000` for access from other devices. No package installation is needed to serve the pages.

The Node server exposes only the landing page and the four demo pages, with or without trailing slashes, including their `index.html` aliases. It supports GET, HEAD, Brotli, gzip, deflate and ETag revalidation, reads edits on each request, and returns 404 for all other paths. Checkout files and directory listings are not public. Google Fonts and the DNS demo's live Google DNS requests still require internet access.

Run `bun install --frozen-lockfile` and `bun test` for the HTTP and DNS regression tests. The DNS tests retain jsdom as a development dependency.

The server reads each page on every request and compares its bytes with the cached source. Only changed bytes need a new hash and compressed representations. These bounded local reads are synchronous; compression runs asynchronously. Rapid same-length edits remain visible even when file timestamps collide. Requests for the same compression share pending work. The current HTML pages are about 5 to 52 KB; responses are buffered, with no per-client compression stream to clean up.

Run `bun scripts/bench-server.mjs` to compare the original server at commit `85ad3e7` against the replacement using the same Node executable. It stages identical pages on the same temporary filesystem, installs only the baseline's frozen dependencies, warms up each workload, alternates server order over five rounds, and prints first-byte and full-body latency medians, tails and per-round medians as JSON. It also measures requests after every same-length page edit. Set `BENCH_TMPDIR` to choose the temporary filesystem, or `BENCH_ROUNDS`, `BENCH_SAMPLES` and `BENCH_WARMUP` for shorter confirmation runs. Baseline request logging is disabled. Startup is measured separately; 404 bodies intentionally differ and are marked as unequal workloads.
