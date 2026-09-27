# mqtt-try

An MQTT broker running on the [Ant](https://github.com/theMackabu/ant) JavaScript runtime, powered by [aedes](https://github.com/moscajs/aedes) (MQTT 3.1/3.1.1/5.0).

The motivation: Ant compiles the whole application - runtime and dependencies included - into a **single ~10 MB static binary**. Pair it with a `FROM scratch` Dockerfile and you get a self-contained MQTT server image with no Node.js install, no `node_modules`, no base OS. Just one file.

## Features

- MQTT TCP on port **1883**
- MQTT over WebSocket on port **1884**
- CONNECT/CONNACK, SUBSCRIBE/SUBACK, PUBLISH routing (incl. `+`/`#` wildcards), QoS acknowledgements, PINGREQ/PINGRESP, retained-session bookkeeping via aedes
- Cross-transport routing: a TCP publisher reaches WebSocket subscribers and vice versa
- Runs on plain Node.js too - the compatibility shim auto-detects and no-ops outside Ant

## Quick start

```sh
ant install                      # or: npm install
sh scripts/apply-patches.sh      # or: npm run patch-deps (npm postinstall does this too)
ant server.js                    # or: node server.js / npm start
```

## Build a static binary / image

```sh
ant compile server.js   # produces ./server, ~10 MB
./server
```

> **Note:** The binary is only fully static if it embeds the Ant **Linux musl** runtime - pass it explicitly with `ant compile --runtime=/path/to/ant-runtime-linux-musl server.js`. Other runtimes produce dynamically linked binaries (e.g. the default glibc build links `libm`/`libstdc++` and requires `ld-linux`), which **won't run under `FROM scratch`**. Verify with `ldd ./server` - it should print "not a dynamic executable".

The included `Dockerfile` is two meaningful lines:

```dockerfile
FROM scratch
COPY server /
```

Build the binary, `docker build -t mqtt-server .`, and you have a minimal MQTT broker image.

## Why the compat shim (`compat-shim.cjs`)

Ant implements a large but *incomplete* subset of Node's APIs. Everything below is patched at startup - only when `process.versions.ant` is present, so Node and Bun run unmodified:

| Ant gap | Shim |
|---|---|
| `new Buffer(n)` throws; `readUInt8`/`writeUInt16BE`/`readDoubleBE`/`slice` accessors missing | Constructor restored to `alloc()` semantics; all missing methods grafted from the pure-JS [feross/buffer](https://github.com/feross/buffer) prototype onto the native `Buffer.prototype` |
| `setImmediate(fn, a, b)` drops extra arguments | Wrapped to forward arguments via a closure |
| `stream.finished()` returns a non-function instead of a cleanup callback | Wrapped to guarantee a function return |
| `Readable.from()` corrupts async iterables, streams, and object items into Buffer chunks | Reimplemented: pull from the source and `push()` into an object-mode stream |
| Sockets only emit `'data'` - no `'readable'`/`read()` pull mode that aedes requires | Each socket is wrapped in a `readable-stream` `Duplex` (`server.js`) |
| `http` server ignores `Upgrade` headers - no `'upgrade'` event, so `ws`/`websocket-stream` can never handshake | `ws-stream.js` implements the RFC 6455 handshake (`Sec-WebSocket-Accept` via `crypto` SHA-1) and the frame codec directly on a raw TCP socket |

## Why aedes is patched (`patches/`)

One fix can't live in the shim. aedes calls `this._eos()` on disconnect, where `_eos` holds the return value of `stream.finished()`. Under Ant that value is a non-function object - but aedes binds `finished` via `import { finished } from 'stream'`, and Ant snapshots ESM named bindings of builtins, so the shim's `require('stream')` mutation never reaches it.

`patches/aedes+1.2.0.patch` therefore guards the call site:

```diff
-    this._eos()
+    if (typeof this._eos === 'function') this._eos()
```

Without it, **every** client disconnect throws `TypeError: object is not a function` mid-teardown - skipping the subscription cleanup below it, so dead clients keep accumulating subscriptions and receive publish attempts.

`patch-package` itself can't apply the patch (it doesn't recognize `ant.lockb`), so `scripts/apply-patches.sh` applies it with `git apply` - deterministic, non-interactive, and idempotent. Run it after every `ant install`.

## Layout

```
server.js            entry point: aedes + TCP/WS listeners
ws-stream.js         WebSocket handshake + frame codec on raw TCP
compat-shim.cjs      Ant runtime compatibility layer (no-ops on Node/Bun)
patches/             unified diffs applied to node_modules
scripts/apply-patches.sh
Dockerfile           FROM scratch + the compiled binary
```
