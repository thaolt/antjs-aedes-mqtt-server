import { wrapSocket, createWsServer } from './compat-shim.js';
import net from 'net';
import { Aedes } from 'aedes';

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

  // Raw-socket RFC 6455 under ant; http + ws under Node/Bun.
  const wsServer = createWsServer(function(conn){
    aedes.handle(conn);
  });

  wsServer.listen(1884, function(){
    console.log('mqtt over websocket listening on port 1884');
  });
}).catch(function(e){
  console.log('aedes listen failed:', e.message);
});
