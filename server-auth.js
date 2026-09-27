import { wrapSocket, createWsServer } from './compat-shim.js';
import net from 'net';
import { Aedes } from 'aedes';

// Demo user database. In a real deployment, check credentials against a
// database/hash instead of comparing plaintext.
const users = {
  admin:  { password: 'secret',    pub: ['#'],                    sub: ['#'] },
  sensor: { password: 'sensor123', pub: ['sensors/#'],            sub: ['sensors/#', 'commands/#'] },
  reader: { password: 'reader123', pub: [],                       sub: ['sensors/#'] },
};

// MQTT topic filter match: '+' single level, '#' multi level (tail only).
function topicMatches(filter, topic) {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return i === f.length - 1;
    if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

const aedes = new Aedes();

// Called during CONNECT. password is a Buffer. Reject with an error carrying
// an MQTT CONNACK returnCode (4 = bad credentials, 5 = not authorized).
aedes.authenticate = function (client, username, password, callback) {
  const user = username && users[username.toString()];
  if (!user || !password || password.toString() !== user.password) {
    const err = new Error('auth failure');
    err.returnCode = 4;
    console.log(`auth rejected for client ${client.id} (username: ${username})`);
    return callback(err, false);
  }
  client.user = user;
  console.log(`client ${client.id} authenticated as "${username}"`);
  callback(null, true);
};

// Called per PUBLISH. callback(null) allows, callback(err) denies.
aedes.authorizePublish = function (client, packet, callback) {
  const allowed = (client.user && client.user.pub).some(f => topicMatches(f, packet.topic));
  if (!allowed) {
    console.log(`publish denied: ${client.id} -> ${packet.topic}`);
    return callback(new Error('publish not allowed'));
  }
  callback(null);
};

// Called per subscription filter. callback(null, sub) allows,
// callback(null, null) denies it (client gets SUBACK failure 0x80).
aedes.authorizeSubscribe = function (client, sub, callback) {
  const allowed = (client.user && client.user.sub).some(f => topicMatches(f, sub.topic));
  if (!allowed) {
    console.log(`subscribe denied: ${client.id} -> ${sub.topic}`);
    return callback(null, null);
  }
  callback(null, sub);
};

aedes.listen().then(function(){
  const server = net.createServer(function(conn){
    aedes.handle(wrapSocket(conn));
  });
  server.listen(2883, function(){
    console.log('mqtt (auth) listening on port 2883');
  });

  const wsServer = createWsServer(function(conn){
    aedes.handle(conn);
  });
  wsServer.listen(2884, function(){
    console.log('mqtt over websocket (auth) listening on port 2884');
  });
}).catch(function(e){
  console.log('aedes listen failed:', e.message);
});
