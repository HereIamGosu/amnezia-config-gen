// __tests__/helpers/free-port.js
// A free port from the OS ephemeral range for a server.js child. The server test files run in parallel, and random
// ports drawn from overlapping fixed ranges (41000-45500) could collide: the second server exits with EADDRINUSE.

'use strict';

const net = require('node:net');

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

module.exports = { freePort };
