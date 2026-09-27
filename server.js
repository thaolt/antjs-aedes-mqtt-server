import { wrapSocket } from './compat-shim.cjs';
import net from 'net';
import { Aedes } from 'aedes';
import { wsStream } from './ws-stream.js';

const aedes = new Aedes();

// aedes 1.x requires listen() to be called before handle() works —
// it sets broker.closed = false and initializes persistence.
aedes.listen().then(function(){
  const server = net.createServer(function(conn){
    aedes.handle(wrapSocket(conn));
  });

  server.listen(1883, function(){
    console.log('mqtt listening on port 1883');
  });

  // Ant's http server ignores Upgrade requests, so MQTT-over-WebSocket is
  // served by ws-stream.js performing the WS handshake on a raw TCP socket.
  const wsServer = net.createServer(function(conn){
    aedes.handle(wsStream(conn));
  });

  wsServer.listen(1884, function(){
    console.log('mqtt over websocket listening on port 1884');
  });
}).catch(function(e){
  console.log('aedes listen failed:', e.message);
});
