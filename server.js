import './compat-shim.cjs';
import net from 'net';
import { Duplex } from 'readable-stream';
import { Aedes } from 'aedes';

const aedes = new Aedes();

// ant sockets only emit 'data'; aedes needs the pull-style 'readable'/read()
// interface. Adapt the socket with a readable-stream Duplex.
function wrapSocket(socket) {
  const d = new Duplex({
    write(chunk, enc, cb) {
      socket.write(chunk);
      cb();
    },
    final(cb) {
      socket.end();
      cb();
    },
    destroy(err, cb) {
      socket.destroy();
      cb(err);
    },
    read() {}
  });
  socket.on('data', c => d.push(c));
  socket.on('end', () => d.push(null));
  socket.on('error', e => d.destroy(e));
  socket.on('close', () => d.push(null));
  return d;
}

// aedes 1.x requires listen() to be called before handle() works —
// it sets broker.closed = false and initializes persistence.
aedes.listen().then(function(){
  const server = net.createServer(function(conn){
    aedes.handle(wrapSocket(conn));
  });

  server.listen(1883, function(){
    console.log('mqtt listening on port 1883');
  });
}).catch(function(e){
  console.log('aedes listen failed:', e.message);
});
