// __tests__/helpers/sigterm-on-stdin.js
// Preload for a server.js child process (`node --require`): a line on stdin runs the process's SIGTERM handlers,
// as a stop of the container does. A real SIGTERM from child.kill() ends a process on Windows without running
// any handler, so the tests deliver it this way on every platform.

'use strict';

process.stdin.on('data', () => process.emit('SIGTERM'));
