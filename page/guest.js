// One container's guest, in a worker of the container's tab.
//
// The supervisor (internal/supervisor) started this browser and serves
// the page, and the page (main.js) starts this worker. The worker boots
// a Linux guest with unkernel, gives the guest the container image as a
// file system whose every lookup is a request back to the supervisor,
// and runs the container's program when the supervisor says to. The
// program's output goes to the supervisor over one WebSocket, and its
// input, signals and window size come back the same way. The page is
// told what to show: the container's name, its state and its output.
//
// The guest is in a worker because of its CPUs. The SDK runs each CPU
// after the first in a thread of its own, and a CPU blocks while it
// waits for another, which a browser lets a worker do and never a
// page's main thread. The SDK can move the kernel to a worker itself,
// but then the guest's network has to be one the SDK builds there, and
// this guest's network is the supervisor (supervisorNet).

import { checkSupport, createKernel, FsError, MemoryFs } from "./unkernel/web.mjs";
import { State, ToGuest, ToPage } from "./messages.js";

// What the supervisor serves next to this page.
const CONFIG_URL = "config.json";
const SPEC_URL = "spec.json";
const INIT_URL = "init";
const FS_URL = "fs/";
const CONTROL_URL = "ctl";
const NET_DNS_URL = "net/dns";
const NET_TCP_URL = "net/tcp";
const INBOUND_URL = "in";
const EXEC_URL = "ex";
const VOLUME_URL = "vol/";

// Where the guest finds the image, and init with the container's spec.
const LOWER_DIR = "/tabc/lower";
const BIN_DIR = "/tabc/bin";
const INIT_NAME = "init";
// The argument that makes init watch the program's open ports.
const PORTS_FLAG = "--ports";
// The argument that makes init run a second program in the container.
const EXEC_FLAG = "--exec";
const SPEC_NAME = "spec.json";
const EXECUTABLE = 0o755;

// The image's root, as the guest names it.
const ROOT = "/";

// How long an answer about a volume's attributes is kept (volumeFs).
const VOLUME_KEEP_MS = 1000;

// The image's lookups wait on the supervisor's disk, never on a network,
// so the SDK's request timeout is off: a slow disk is not an error.
const NO_TIMEOUT = 0;

// A connection's count of bytes the guest has taken, as the supervisor
// reads one (internal/supervisor, netAck), and how many bytes are taken
// between two counts: a sixteenth of the supervisor's window of 4 MiB,
// so the window is never close to used up by bytes not yet counted.
const NET_ACK = "ack";
const NET_ACK_BYTES = 256 << 10;

// What a guest gets on a page with no shared memory for more CPUs.
const SINGLE_CPU = 1;

// The kernel as the SDK ships it, built for one CPU, and the kernel for
// several CPUs. The SDK can make the second from the first in the page,
// and takes about 150 ms of every start to do so; tabc's build makes
// the several-CPU kernel once instead.
const KERNEL_ONE_CPU_URL = "unkernel/unkernel.wasm";
const KERNEL_SMP_URL = "unkernel/unkernel-smp.wasm";

// The guest kernel's command line: the SDK's own, and one parameter
// more. Linux waits out an RCU grace period, tens of milliseconds once
// a second CPU is up, in calls such as closing a packet socket, and the
// guest's DHCP client at boot makes six of them: 190 ms before the
// first program can start. The parameter has the kernel interrupt the
// other CPUs and end the grace period at once.
const KERNEL_CMDLINE = "console=hvc0 rdinit=/init rcupdate.rcu_expedited=1";

// The first byte of a binary message says which stream its bytes are.
const Stream = Object.freeze({
  STDIN: 0,
  STDOUT: 1,
  STDERR: 2,
});

// The messages in each direction, by their `t` field.
const FromSupervisor = Object.freeze({
  START: "start",
  EOF: "eof",
  KILL: "kill",
  RESIZE: "resize",
  CONNECT: "connect",
  EXEC: "exec",
  WELCOME: "welcome",
  TAKEN: "taken",
});
const ToSupervisor = Object.freeze({
  READY: "ready",
  EXIT: "exit",
  LOG: "log",
  ERROR: "error",
  LISTEN: "listen",
  UNLISTEN: "unlisten",
});

// How a program's end is reported by the SDK, and the status a program
// ended by a signal is given, as a shell gives one.
const END_EXIT = "exit";
const END_SIGNAL = "signal";
const SIGNAL_STATUS_BASE = 128;
// The status for a session that ended with neither, a lost guest.
const LOST_STATUS = 255;

// What a WebSocket holds unsent before its sender waits, and how often
// a waiting sender looks again.
const SEND_HIGH_WATER = 1 << 20;
const SEND_POLL_MS = 5;

// The escape sequence that prints what follows in red, and the one that
// ends it, for what the guest's side itself has to say.
const RED = "\x1b[31m";
const PLAIN = "\x1b[0m";

// The size of the terminal a tab that is not the container shows its
// one message on.
const NOTICE_COLS = 80;
const NOTICE_ROWS = 24;

// Have the page say how the container is doing.
function setStatus(state, text) {
  postMessage({ t: ToPage.STATUS, state, text });
}

// Have the page write a chunk, text or bytes, on its terminal.
function show(chunk) {
  postMessage({ t: ToPage.SHOW, chunk });
}

// Have the page make its terminal for a container. What is typed into
// the terminal comes back as ToGuest.TYPED messages.
function openTerminal({ terminal, cols, rows }) {
  postMessage({ t: ToPage.OPEN, terminal, cols, rows });
}

const control = new WebSocket(new URL(CONTROL_URL, location.href).href.replace(/^http/, "ws"));
control.binaryType = "arraybuffer";

// Tell the supervisor something as JSON.
function tell(type, fields = {}) {
  control.send(JSON.stringify({ t: type, ...fields }));
}

// Anything that goes wrong here ends the container: the supervisor
// reports the message and exits.
function fatal(error) {
  // What went wrong first, then where. A stack alone is not enough:
  // Firefox's does not begin with the error's message, as Chromium's
  // does.
  const what = error?.message ?? String(error);
  const where = error?.stack ?? "";
  const message = where.includes(what) ? where : `${what}\n${where}`;
  setStatus(State.FAILED, "failed");
  show(`\r\n${RED}${message.replaceAll("\n", "\r\n")}${PLAIN}\r\n`);
  if (control.readyState === WebSocket.OPEN) {
    tell(ToSupervisor.ERROR, { message });
  }
}
addEventListener("error", (event) => fatal(event.error ?? event.message));
addEventListener("unhandledrejection", (event) => fatal(event.reason));

// One JSON document from the supervisor.
async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: ${response.status}`);
  }
  return response.json();
}

// The container image as the guest's file system. Read-only: the
// guest's init puts a writable layer over it.
//
// An image does not change under a running container, so nothing is
// asked twice. A directory's listing carries each entry's attributes
// and each link's target, and every lookup is answered from the
// listing of the directory the path is in: one request per directory
// the guest ever looks into, however many names it tries there. A
// program that searches ten directories for a library asks ten
// questions, and the nine answers of "not here" cost nothing more.
function imageFs() {
  const call = async (op, path, extra = "") => {
    const response = await fetch(`${FS_URL}${op}?p=${encodeURIComponent(path)}${extra}`);
    if (response.ok) {
      return response;
    }

    // The supervisor names the errno the guest should see.
    const { code } = await response.json();
    throw new FsError(code);
  };

  // Each directory's entries by name, as a promise so that lookups
  // arriving together share one request. A failed listing is forgotten,
  // so the error is the guest's and not the cache's.
  const listings = new Map();
  const listing = (path) => {
    let entries = listings.get(path);
    if (entries === undefined) {
      entries = call("dir", path)
        .then((response) => response.json())
        .then((list) => new Map(list.map((entry) => [entry.name, entry])));
      entries.catch(() => listings.delete(path));
      listings.set(path, entries);
    }
    return entries;
  };

  // The root has no directory to be listed in, so its attributes are
  // asked for once by name.
  let rootAttr;
  const entryOf = async (path) => {
    if (path === ROOT) {
      rootAttr ??= call("attr", ROOT).then((response) => response.json());
      return { attr: await rootAttr };
    }

    const cut = path.lastIndexOf("/");
    const entries = await listing(cut === 0 ? ROOT : path.slice(0, cut));
    const entry = entries.get(path.slice(cut + 1));
    if (entry === undefined) {
      throw new FsError("ENOENT");
    }
    return entry;
  };

  return {
    getattr: async (path) => (await entryOf(path)).attr,
    readdir: async (path) =>
      [...(await listing(path)).values()].map(({ name, type, ino }) => ({ name, type, ino })),
    readlink: async (path) => (await entryOf(path)).target,
    open: async (path, flags) => {
      if (flags.write) {
        throw new FsError("EROFS");
      }

      // Opening checks the file is there; each read names its range.
      const { attr } = await entryOf(path);
      return {
        read: async (offset, length) =>
          new Uint8Array(
            await (await call("read", path, `&o=${offset}&n=${length}`)).arrayBuffer(),
          ),
        getattr: () => attr,
      };
    },
  };
}

// A volume as a file system of the guest: a directory of the host that
// the container reads and writes. Unlike the image it changes, under
// the container's hands and under the host's, so an answer is kept only
// briefly: every change goes to the supervisor, and every question too,
// unless the same question was answered less than VOLUME_KEEP_MS ago.
//
// The guest's kernel asks for a file's attributes several times for one
// use of it: once as it walks to the name, again when it opens it, and
// once more for the program's stat. And a program that lists a
// directory then asks about each name in it, as find, a compiler or a
// module resolver does. A listing carries each entry's attributes, so
// those answers are kept from the listing, and the questions that
// follow cost nothing.
//
// A change the guest makes forgets everything kept, so the guest always
// sees its own changes at once. A change the host makes shows within
// VOLUME_KEEP_MS here, and the guest's kernel keeps an answer for a
// second more (its metatimeout), so within about two seconds in all.
// Contents are never kept: each read is a request.
function volumeFs(index) {
  const base = `${VOLUME_URL}${index}/`;
  const request = async (op, params, init) => {
    const response = await fetch(`${base}${op}?${new URLSearchParams(params)}`, init);
    if (response.ok) {
      return response;
    }
    const { code } = await response.json();
    throw new FsError(code);
  };
  const ask = (op, path, extra = {}) => request(op, { p: path, ...extra });

  // Attributes by path, each with when it was asked, as a promise so
  // that questions arriving together share one request. A name that is
  // not there is kept as that answer too, since a program looking for a
  // file asks after many names that do not exist; any other error is
  // forgotten, so the error is the guest's and not the cache's.
  //
  // Whatever is older than VOLUME_KEEP_MS is never used again, so the
  // whole map is dropped once that long has passed since it was last
  // emptied: a walk over a large tree keeps a second's worth of names,
  // not every name it ever saw.
  const kept = new Map();
  let emptied = performance.now();
  // Counts the changes, so that an answer asked for before a change and
  // arriving after it is not kept (a listing is not in the map while it
  // is in flight, as an attribute question is).
  let changes = 0;
  const forget = () => {
    kept.clear();
    emptied = performance.now();
    changes += 1;
  };
  const keep = (path, answer) => {
    if (performance.now() - emptied > VOLUME_KEEP_MS) {
      kept.clear();
      emptied = performance.now();
    }
    const entry = { at: performance.now(), answer };
    kept.set(path, entry);
    answer.catch((error) => {
      if (error?.code !== "ENOENT" && kept.get(path) === entry) {
        kept.delete(path);
      }
    });
    return answer;
  };
  const attrOf = (path) => {
    const entry = kept.get(path);
    if (entry !== undefined && performance.now() - entry.at < VOLUME_KEEP_MS) {
      return entry.answer;
    }
    return keep(
      path,
      ask("attr", path).then((response) => response.json()),
    );
  };

  // A change forgets everything, before it is sent and again once it is
  // done, so no answer from before or during the change survives it.
  const change = async (op, path, extra = {}, body = undefined) => {
    forget();
    try {
      return await request(op, { p: path, ...extra }, { method: "POST", body });
    } finally {
      forget();
    }
  };
  const octal = (mode) => mode.toString(8);

  // An open file, by path: reads and writes each name their range.
  const fileAt = (path) => ({
    read: async (offset, length) =>
      new Uint8Array(await (await ask("read", path, { o: offset, n: length })).arrayBuffer()),
    write: async (offset, data) =>
      (await (await change("write", path, { o: offset }, data)).json()).written,
    getattr: () => attrOf(path),
    setattr: (attr) => change("setattr", path, {}, JSON.stringify(attr)),
  });

  return {
    getattr: attrOf,
    readdir: async (path) => {
      const before = changes;
      const list = await (await ask("dir", path)).json();
      const parent = path === ROOT ? "" : path;
      for (const { name, attr } of list) {
        if (changes === before) {
          keep(`${parent}/${name}`, Promise.resolve(attr));
        }
      }
      return list.map(({ name, type, ino }) => ({ name, type, ino }));
    },
    readlink: async (path) => (await (await ask("link", path)).json()).target,
    open: async (path, flags) => {
      await attrOf(path);
      if (flags.truncate) {
        await change("setattr", path, {}, JSON.stringify({ size: 0 }));
      }
      return fileAt(path);
    },
    create: async (path, mode) => {
      await change("create", path, { m: octal(mode) });
      return fileAt(path);
    },
    mkdir: (path, mode) => change("mkdir", path, { m: octal(mode) }),
    symlink: (path, target) => change("symlink", path, { t: target }),
    link: (target, path) => change("hardlink", path, { t: target }),
    remove: (path, dir) => change("remove", path, { d: dir ? 1 : 0 }),
    rename: (from, to) => change("rename", from, { t: to }),
    setattr: (path, attr) => change("setattr", path, {}, JSON.stringify(attr)),
  };
}

// The guest's network: each TCP connection the guest opens is one
// WebSocket to the supervisor, which dials the host and port from the
// container's network namespace, and each name is looked up there too.
function supervisorNet() {
  const tcpUrl = new URL(NET_TCP_URL, location.href).href.replace(/^http/, "ws");

  return {
    async lookup(name) {
      const response = await fetch(`${NET_DNS_URL}?name=${encodeURIComponent(name)}`);
      if (!response.ok) {
        throw Object.assign(new Error(`no such host: ${name}`), { code: "ENOTFOUND" });
      }
      return response.json();
    },

    connect({ host, port }, events) {
      const socket = new WebSocket(`${tcpUrl}?host=${encodeURIComponent(host)}&port=${port}`);
      socket.binaryType = "arraybuffer";

      // Data that arrived while the guest's stack asked for a pause.
      let paused = false;
      let held = [];
      let closed = false;
      let draining = false;

      // Hand the guest's stack a chunk of the peer's bytes, and tell
      // the supervisor how much the stack has taken. The supervisor
      // stops reading from the peer once a window of bytes is on its
      // way and not yet taken, so a peer cannot fill the page faster
      // than the guest reads, and without the count the supervisor
      // would stop for good after one window. The count is sent every
      // NET_ACK_BYTES and not with each chunk.
      let taken = 0;
      const deliver = (data) => {
        events.onData(data);
        taken += data.length;
        if (taken < NET_ACK_BYTES || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        socket.send(JSON.stringify({ t: NET_ACK, n: taken }));
        taken = 0;
      };

      const close = (error) => {
        if (closed) {
          return;
        }
        closed = true;
        events.onClose(error);
      };

      // The supervisor's text messages mark the connection's stages;
      // binary messages are the peer's bytes.
      socket.onmessage = (message) => {
        if (typeof message.data === "string") {
          const { t, message: why } = JSON.parse(message.data);
          if (t === "open") {
            events.onConnect();
          } else if (t === "end") {
            events.onEnd();
          } else if (t === "error") {
            close(new Error(why));
            socket.close();
          }
          return;
        }

        const data = new Uint8Array(message.data);
        if (paused) {
          held.push(data);
          return;
        }
        deliver(data);
      };
      socket.onclose = () => close(null);
      socket.onerror = () => close(new Error(`connection to ${host}:${port} failed`));

      // Report once what was written has left, which is when the
      // guest's stack sends more.
      const watchDrain = () => {
        if (draining) {
          return;
        }
        draining = true;
        const look = () => {
          if (closed) {
            return;
          }
          if (socket.bufferedAmount > 0) {
            setTimeout(look, SEND_POLL_MS);
            return;
          }
          draining = false;
          events.onDrain();
        };
        setTimeout(look, SEND_POLL_MS);
      };

      return {
        write(data) {
          socket.send(data);
          watchDrain();
        },
        end() {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ t: "end" }));
          }
        },
        destroy() {
          closed = true;
          socket.close();
        },
        pause() {
          paused = true;
        },
        resume() {
          paused = false;
          // The stack may ask for a pause again partway through what
          // was held, and the rest then waits for the next resume.
          while (!paused && held.length > 0) {
            deliver(held.shift());
          }
        },
        get buffered() {
          return socket.bufferedAmount;
        },
      };
    },
  };
}

// Open a connection to a port in the guest for the supervisor, which
// accepted one from outside and cannot reach into the guest itself. The
// page answers on a WebSocket that names the request, and copies bytes
// both ways. Either side finishing its sending is passed on as that:
// the other may still have an answer to send.
async function connectInbound(vm, id, port) {
  // The guest's side first. The supervisor sends the outside's bytes
  // the moment the WebSocket below opens, so everything that receives
  // them has to exist by then.
  let guest = null;
  let failure = null;
  try {
    guest = await vm.connect(port);
  } catch (error) {
    failure = error;
  }

  const url = new URL(INBOUND_URL, location.href).href.replace(/^http/, "ws");
  const socket = new WebSocket(`${url}?id=${encodeURIComponent(id)}`);
  socket.binaryType = "arraybuffer";

  // Nothing listens on the port, or the guest refused: the supervisor
  // is told, and drops the outside's connection.
  if (failure !== null) {
    socket.onopen = () => {
      socket.send(JSON.stringify({ t: "error", message: String(failure?.message ?? failure) }));
      socket.close();
    };
    return;
  }

  // Outside to guest, in order. The outside finishing its sending is
  // passed on as that, an end of input on the guest's side, and the
  // connection stays: the guest may still have an answer to send.
  const writer = guest.writable.getWriter();
  let writes = Promise.resolve();
  const ignore = () => {};
  socket.onmessage = (message) => {
    if (typeof message.data === "string") {
      writes = writes.then(() => writer.close()).catch(ignore);
      return;
    }
    const data = new Uint8Array(message.data);
    writes = writes.then(() => writer.write(data)).catch(ignore);
  };
  socket.onclose = () => guest.close();
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("no inbound connection to the supervisor"));
  });

  // Guest to outside.
  const reader = guest.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      while (socket.bufferedAmount > SEND_HIGH_WATER) {
        await new Promise((resolve) => setTimeout(resolve, SEND_POLL_MS));
      }
      socket.send(value);
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ t: "end" }));
    }
  } catch {
    socket.close();
  }
}

// Start a second program in the container for the supervisor, which
// was asked by `tabc exec`. Like a connection into the guest, the
// answer is a WebSocket that names the request. The socket carries what
// the container's own program has on the control socket: input, signals
// and sizes one way, and output and the exit status the other.
async function runExec(vm, request) {
  // The program first. The supervisor sends input the moment the
  // WebSocket below opens, so what receives the input has to exist by
  // then.
  const init = `${BIN_DIR}/${INIT_NAME}`;
  const args = [EXEC_FLAG, request.spec];
  let program = null;
  let failure = null;
  try {
    program = request.terminal
      ? await vm.spawn(init, args, {
          user: "root",
          cwd: "/",
          cols: request.cols,
          rows: request.rows,
          term: request.term,
        })
      : await vm.spawn(init, args, { pty: false, user: "root", cwd: "/" });
  } catch (error) {
    failure = error;
  }

  const url = new URL(EXEC_URL, location.href).href.replace(/^http/, "ws");
  const socket = new WebSocket(`${url}?id=${encodeURIComponent(request.id)}`);
  socket.binaryType = "arraybuffer";
  const say = (type, fields = {}) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ t: type, ...fields }));
    }
  };

  // The guest could not start the program: the supervisor is told why.
  if (failure !== null) {
    socket.onopen = () => {
      say(ToSupervisor.ERROR, { message: String(failure?.message ?? failure) });
      socket.close();
    };
    return;
  }

  // Input, in order, and signals and sizes. On pipes the end of input
  // is passed on; a terminal has none.
  const stdin = request.terminal ? null : program.stdin.getWriter();
  let writes = Promise.resolve();
  const ignore = () => {};
  socket.onmessage = (message) => {
    if (message.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(message.data).subarray(1);
      if (request.terminal) {
        program.write(bytes);
        return;
      }
      writes = writes.then(() => stdin.write(bytes)).catch(ignore);
      return;
    }

    const { t, signal, cols, rows } = JSON.parse(message.data);
    if (t === FromSupervisor.KILL) {
      program.kill(signal);
    } else if (t === FromSupervisor.RESIZE && request.terminal) {
      program.resize(cols, rows);
    } else if (t === FromSupervisor.EOF && !request.terminal) {
      writes = writes.then(() => stdin.close()).catch(ignore);
    }
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("no exec connection to the supervisor"));
  });

  // Output, each chunk under its stream's number, sent only as fast as
  // the supervisor takes it.
  const forward = async (readable, stream) => {
    const reader = readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      while (socket.bufferedAmount > SEND_HIGH_WATER) {
        await new Promise((resolve) => setTimeout(resolve, SEND_POLL_MS));
      }
      const framed = new Uint8Array(value.length + 1);
      framed[0] = stream;
      framed.set(value, 1);
      socket.send(framed);
    }
  };
  if (request.terminal) {
    await forward(program.output, Stream.STDOUT);
  } else {
    await Promise.all([
      forward(program.stdout, Stream.STDOUT),
      forward(program.stderr, Stream.STDERR),
    ]);
  }

  say(ToSupervisor.EXIT, { status: statusOf(await program.ended) });
  socket.close();
}

// Watch which ports the container's program listens on, and tell the
// supervisor, which listens on the same ports outside. Init prints a
// line per change, "+80" or "-80".
async function watchPorts(vm) {
  const watcher = await vm.spawn(`${BIN_DIR}/${INIT_NAME}`, [PORTS_FLAG], {
    pty: false,
    user: "root",
    cwd: "/",
  });
  watcher.stderr.cancel();

  const reader = watcher.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      return;
    }
    pending += value;
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      const port = Number(line.slice(1));
      if (!Number.isInteger(port) || port <= 0) {
        continue;
      }
      tell(line[0] === "+" ? ToSupervisor.LISTEN : ToSupervisor.UNLISTEN, { port });
    }
  }
}

// Send one chunk of a program's output, after waiting for the socket to
// have room: the program's output stream is only read as fast as the
// supervisor takes it.
async function sendOutput(stream, chunk) {
  show(chunk);
  while (control.bufferedAmount > SEND_HIGH_WATER) {
    await new Promise((resolve) => setTimeout(resolve, SEND_POLL_MS));
  }
  const framed = new Uint8Array(chunk.length + 1);
  framed[0] = stream;
  framed.set(chunk, 1);
  control.send(framed);
}

// Forward everything a stream produces as `stream`'s output.
async function pump(readable, stream) {
  const reader = readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      return;
    }
    await sendOutput(stream, value);
  }
}

// The exit status for how a program ended.
function statusOf(end) {
  if (end.type === END_EXIT) {
    return end.code;
  }
  if (end.type === END_SIGNAL) {
    return SIGNAL_STATUS_BASE + end.signal;
  }
  return LOST_STATUS;
}

// Run the container's program on a terminal. The supervisor's messages
// become the terminal's input, signals and size.
async function runOnTerminal(vm, config, incoming) {
  const pty = await vm.spawn(`${BIN_DIR}/${INIT_NAME}`, [`${BIN_DIR}/${SPEC_NAME}`], {
    user: "root",
    cwd: "/",
    cols: config.cols,
    rows: config.rows,
    term: config.term,
  });

  incoming.onInput = (bytes) => pty.write(bytes);
  // A terminal has no end of input to pass on: its program reads until
  // the program itself ends.
  incoming.onEof = () => {};
  incoming.onKill = (signal) => pty.kill(signal);
  incoming.onResize = (cols, rows) => {
    pty.resize(cols, rows);
    postMessage({ t: ToPage.RESIZE, cols, rows });
  };

  await pump(pty.output, Stream.STDOUT);
  return statusOf(await pty.ended);
}

// Run the container's program on pipes.
async function runOnPipes(vm, incoming) {
  const program = await vm.spawn(`${BIN_DIR}/${INIT_NAME}`, [`${BIN_DIR}/${SPEC_NAME}`], {
    pty: false,
    user: "root",
    cwd: "/",
  });

  // Writes are chained so the bytes and the end of input reach the
  // program in the order they arrived.
  const stdin = program.stdin.getWriter();
  let writes = Promise.resolve();
  const ignore = () => {};
  incoming.onInput = (bytes) => {
    writes = writes.then(() => stdin.write(bytes)).catch(ignore);
  };
  incoming.onEof = () => {
    writes = writes.then(() => stdin.close()).catch(ignore);
  };
  incoming.onKill = (signal) => program.kill(signal);
  incoming.onResize = () => {};

  await Promise.all([pump(program.stdout, Stream.STDOUT), pump(program.stderr, Stream.STDERR)]);
  return statusOf(await program.ended);
}

async function main() {
  await new Promise((resolve, reject) => {
    control.onopen = resolve;
    control.onerror = () => reject(new Error("no connection to the supervisor"));
  });

  // The supervisor's first word says whether this page is the
  // container. The same address opened in a second tab is not: the
  // first tab is, and a second guest would be a second container that
  // nothing is connected to.
  const first = await new Promise((resolve) => {
    control.onmessage = (event) => resolve(JSON.parse(event.data).t);
    control.onclose = () => resolve(FromSupervisor.TAKEN);
  });
  if (first !== FromSupervisor.WELCOME) {
    control.onclose = null;
    setStatus(State.FAILED, "open elsewhere");
    openTerminal({ terminal: false, cols: NOTICE_COLS, rows: NOTICE_ROWS });
    show(
      "This container is already running in another tab.\r\nClose this one; the other tab is the container.\r\n",
    );
    return;
  }

  // What the supervisor sends before the program runs is kept, and
  // handed to the program's handlers once there are some.
  const incoming = {
    pending: [],
    onInput: null,
    onEof: null,
    onKill: null,
    onResize: null,
  };
  let started;
  const start = new Promise((resolve) => {
    started = resolve;
  });
  // The guest, once there is one, for requests that are about the guest
  // and not about the program.
  let guest = null;
  const dispatch = (message) => {
    if (message instanceof ArrayBuffer) {
      incoming.onInput(new Uint8Array(message).subarray(1));
      return;
    }
    const { t, signal, cols, rows } = JSON.parse(message);
    if (t === FromSupervisor.EOF) {
      incoming.onEof();
    } else if (t === FromSupervisor.KILL) {
      incoming.onKill(signal);
    } else if (t === FromSupervisor.RESIZE) {
      incoming.onResize(cols, rows);
    }
  };
  control.onmessage = (event) => {
    if (typeof event.data === "string") {
      const request = JSON.parse(event.data);
      const { t, id, port } = request;
      if (t === FromSupervisor.START) {
        started();
        return;
      }
      if (t === FromSupervisor.EXEC) {
        runExec(guest, request).catch((error) =>
          tell(ToSupervisor.LOG, { message: `exec: ${error}` }),
        );
        return;
      }
      if (t === FromSupervisor.CONNECT) {
        connectInbound(guest, id, port).catch((error) =>
          tell(ToSupervisor.LOG, { message: `inbound to port ${port}: ${error}` }),
        );
        return;
      }
    }
    if (incoming.onInput === null) {
      incoming.pending.push(event.data);
      return;
    }
    dispatch(event.data);
  };

  const [config, spec, init] = await Promise.all([
    fetchJson(CONFIG_URL),
    fetch(SPEC_URL).then((response) => response.text()),
    fetch(INIT_URL).then((response) => response.arrayBuffer()),
  ]);

  postMessage({ t: ToPage.TITLE, title: config.title });
  setStatus(State.WAITING, "booting");
  // What is typed into the page goes where the supervisor's input
  // goes, once the program is there to take it.
  addEventListener("message", ({ data }) => {
    if (data.t === ToGuest.TYPED) {
      incoming.onInput?.(data.bytes);
    }
  });
  openTerminal(config);

  // Init and the spec it reads, in a file system of their own.
  const bin = new MemoryFs();
  bin.writeFile(`/${INIT_NAME}`, new Uint8Array(init), { mode: EXECUTABLE });
  bin.writeFile(`/${SPEC_NAME}`, spec);

  // A browser that cannot run the kernel is told so in its own words,
  // before the kernel fails in the kernel's. This is what a person who
  // opened the page in a browser of their own needs to read.
  const support = await checkSupport();
  if (!support.ok) {
    throw new Error(
      `This browser cannot run the container: ${support.problems.join("; ")}. ` +
        "A recent Chrome, Chromium or Firefox can.",
    );
  }

  // The SDK runs each guest CPU after the first in a worker of its own,
  // all on one shared memory. A page that is not cross-origin isolated
  // has no shared memory, and its guest gets one CPU.
  const shared = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === "function";
  const cpus = shared ? config.cpus : SINGLE_CPU;

  // The log's timestamps are how a start-up's time is accounted for.
  tell(ToSupervisor.LOG, { message: `booting the kernel, ${cpus} CPUs` });
  const vm = await createKernel({
    kernel: new URL(cpus > SINGLE_CPU ? KERNEL_SMP_URL : KERNEL_ONE_CPU_URL, location.href).href,
    cmdline: KERNEL_CMDLINE,
    memoryMiB: config.memoryMiB,
    cpus,
    ...(config.network ? { net: supervisorNet() } : {}),
    mounts: {
      [BIN_DIR]: { fs: bin, readOnly: true },
      [LOWER_DIR]: { fs: imageFs(), readOnly: true, requestTimeout: NO_TIMEOUT },
      // Each volume where init expects to find it.
      ...Object.fromEntries(
        (config.volumes ?? []).map((volume, index) => [
          volume.path,
          { fs: volumeFs(index), readOnly: volume.readOnly, requestTimeout: NO_TIMEOUT },
        ]),
      ),
    },
    log: (message) => tell(ToSupervisor.LOG, { message }),
  });

  // The SDK starts fewer CPUs than it was asked for where the browser
  // cannot start the threads, and says why in the log above.
  const booted = vm.stats().cpus;
  if (booted !== cpus) {
    tell(ToSupervisor.LOG, { message: `the guest has ${booted} CPUs, not ${cpus}` });
  }

  // The guest is up and the image is mounted: the container is created.
  guest = vm;
  setStatus(State.WAITING, "created");
  tell(ToSupervisor.READY);
  await start;
  setStatus(State.RUNNING, "running");

  if (config.mirrorPorts) {
    watchPorts(vm).catch((error) => tell(ToSupervisor.LOG, { message: `port watcher: ${error}` }));
  }

  const running = config.terminal ? runOnTerminal(vm, config, incoming) : runOnPipes(vm, incoming);

  // The program's handlers are set by the first synchronous part of
  // the run, after the spawn; what arrived before goes to them now.
  const flush = setInterval(() => {
    if (incoming.onInput === null) {
      return;
    }
    clearInterval(flush);
    for (const message of incoming.pending.splice(0)) {
      dispatch(message);
    }
  }, SEND_POLL_MS);

  const status = await running;
  clearInterval(flush);
  setStatus(State.EXITED, `exited (${status})`);
  tell(ToSupervisor.EXIT, { status });
}

main().catch(fatal);
