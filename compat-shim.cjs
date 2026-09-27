// Compatibility shims for the Ant runtime's incomplete Node.js APIs.
//
// Buffer: ant's Buffer rejects `new Buffer(n)` and lacks most read*/write*
// accessors. Restore constructor semantics and graft the missing methods
// from feross/buffer (npm `buffer`), whose methods operate on plain indexed
// bytes and work on native instances.
var NativeBuffer = globalThis.Buffer;
var PolyfillBuffer = require('buffer/index.js').Buffer;

function BufferCompat(value, encoding) {
  return typeof value === 'number'
    ? NativeBuffer.alloc(value)
    : NativeBuffer.from(value, encoding);
}
BufferCompat.prototype = NativeBuffer.prototype;
Object.setPrototypeOf(BufferCompat, NativeBuffer);

Object.getOwnPropertyNames(PolyfillBuffer.prototype).forEach(function (name) {
  if (name === 'constructor' || name in NativeBuffer.prototype) return;
  var desc = Object.getOwnPropertyDescriptor(PolyfillBuffer.prototype, name);
  try { Object.defineProperty(NativeBuffer.prototype, name, desc); } catch (e) {}
});

globalThis.Buffer = BufferCompat;
try { require('buffer').Buffer = BufferCompat; } catch (e) {}

// ant's setImmediate drops extra arguments; wrap to forward them.
var origSetImmediate = globalThis.setImmediate;
globalThis.setImmediate = function (fn) {
  var args = Array.prototype.slice.call(arguments, 1);
  return origSetImmediate(function () { return fn.apply(null, args); });
};

// ant's stream.finished() returns a non-function; Node returns a cleanup
// function that aedes calls on close. Wrap it to guarantee a function.
try {
  var nodeStream = require('stream');
  var origFinished = nodeStream.finished;
  nodeStream.finished = function (s, cb) {
    var undo = origFinished.apply(this, arguments);
    return typeof undo === 'function' ? undo : function () {};
  };
} catch (e) {}

// ant's Readable.from() doesn't support async iterables, streams, or object
// items — aedes-persistence relies on all three. Readable.from is always
// objectMode; reimplement it by pulling from the source and push()ing.
try {
  var Readable = nodeStream.Readable;
  var origFrom = Readable.from;
  Readable.from = function (src, opts) {
    if (src == null || typeof src === 'string' || NativeBuffer.isBuffer(src) || src instanceof Uint8Array) {
      return origFrom.call(Readable, src, opts);
    }
    var out = new Readable({ objectMode: true, read: function () {} });
    if (typeof src[Symbol.asyncIterator] === 'function') {
      (async function () {
        try {
          for await (var c of src) out.push(c);
          out.push(null);
        } catch (e) { try { out.destroy(e); } catch (_) {} }
      })();
    } else if (typeof src.on === 'function' && typeof src.pipe === 'function') {
      src.on('data', function (c) { out.push(c); });
      src.on('end', function () { out.push(null); });
      src.on('error', function (e) { try { out.destroy(e); } catch (_) {} });
    } else if (typeof src[Symbol.iterator] === 'function') {
      for (var c of src) out.push(c);
      out.push(null);
    } else {
      out.push(src);
      out.push(null);
    }
    return out;
  };
} catch (e) {}
