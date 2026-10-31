// __tests__/helpers/offline-network.js
// Preload for a server.js child process (`node --require`): every outgoing HTTPS request and TCP connect fails
// asynchronously, as an unreachable host does. Handlers run their failure paths, and nothing reaches Cloudflare,
// opencck, GitHub or antifilter.

'use strict';

const https = require('node:https');
const net = require('node:net');
const { EventEmitter } = require('node:events');

const unreachable = () => Object.assign(new Error('connect EHOSTUNREACH (offline test)'), { code: 'EHOSTUNREACH' });

https.request = () => {
  const req = new EventEmitter();
  req.write = () => true;
  req.destroy = () => req;
  req.end = () => {
    setImmediate(() => req.emit('error', unreachable()));
    return req;
  };
  return req;
};

// net.createConnection goes through Socket#connect too; the server's own accepted sockets never call it.
net.Socket.prototype.connect = function connect() {
  setImmediate(() => this.emit('error', unreachable()));
  return this;
};
