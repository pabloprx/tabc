# Design

tabc runs a container in a browser tab. This is how the pieces fit, and
why each is where it is.

## The pieces

| piece      | where                 | what it does                                                         |
| ---------- | --------------------- | -------------------------------------------------------------------- |
| `tabc`     | `cmd/tabc`            | the commands an engine calls, each over in a moment                  |
| supervisor | `internal/supervisor` | one per container; owns the browser, serves the page, carries stdio  |
| page       | `page/`               | boots the guest in a worker, runs the program, shows a terminal      |
| guest      | [unkernel]            | Linux compiled to WebAssembly, with an emulator for aarch64 programs |
| init       | `cmd/tabc-init`       | first program in the guest; builds the root, becomes the user, execs |

## Life of a container

1. **create.** tabc reads the bundle into a plan (`internal/plan`): the
   program, where the files are, the terminal, the memory. It starts
   the supervisor in a session of its own and waits for one line on a
   pipe.
2. The supervisor listens on a loopback port behind a random token,
   starts headless Chromium with a fresh profile, and points it at the
   page.
3. The page boots the guest and mounts two file systems: a small one
   holding init and the container's spec, and the image.
4. The page says ready. The supervisor writes `ok` on the pipe, create
   writes the pid file and exits. The pid is the supervisor's.
5. **start.** tabc sends `start` over the supervisor's control socket.
   The page spawns init, and init execs the program.
6. Output goes page to supervisor to wherever the engine pointed
   stdout. Input, signals and window sizes go the other way.
7. The program ends. The page reports the status, the supervisor
   exits with it, and the engine reaps the supervisor as it would any
   container.

`tabc run <image>` is the same from step 2 on. The plan comes from the
image's configuration, and the files from its layers.

## Files

A page cannot read the host's disk. unkernel mounts anything that
answers three questions about a path: its attributes, its entries, its
bytes. The page answers by asking the supervisor over HTTP
(`internal/rootfs`).

The supervisor reads from one of two places:

- **A directory**, for a bundle. Every request goes through `os.Root`,
  so no path, and no symbolic link, reaches outside the image.
- **The image's layers**, for `tabc run`. Each layer is a tar file.
  tabc reads the headers once, applies whiteouts, and remembers where
  each file's bytes are. A read is a range of the tar file. Nothing is
  unpacked, which is what lets a Mac's file system hold a Linux image
  with its owners, modes and names intact.

Either way the image is read-only. Init puts a tmpfs over it with
overlayfs, so the container sees a writable root and the host's copy
never changes.

## Network

unkernel ends the guest's Ethernet frames in a small stack on the page
and hands each TCP connection and each name lookup to a backend. tabc's
backend is its own: one WebSocket per connection and one request per
lookup, both to the supervisor, which dials and resolves for the guest.

The supervisor runs inside the container's network namespace. With
podman it joins the namespace the engine made. With Docker it is
started in a new one, and Docker's own hook attaches the interface.
Connections then leave from the container's address, a container with
no network reaches nothing, and the browser itself is on no other
network.

The supervisor reads from a peer only while less than 4 MiB is on its
way to a guest that has not taken it, and the page reports what the
guest takes. On a laptop, to a server on the same machine, a guest
downloads at about 200 MB/s and uploads at about 50 MB/s.

Only TCP and name lookups are carried. There is no UDP.

### Connections in

A server in the guest is reached through the supervisor, which listens
on the host side and, for each connection, asks the page to open one
to the same port in the guest. The page cannot be connected to, only
asked, so the last hop is the page's: it opens the guest's side and
then a WebSocket back to the supervisor that names the request.

Which ports the supervisor listens on depends on where it runs. In a
network namespace of the container's own it mirrors every port the
program opens, which a small watcher in the guest reports. That is
what Docker's bridge, its `-p` and its other containers connect to.
On the host's network it listens only where `-p` says.

### Without an engine

With no Docker there is no bridge and no DNS that knows a container's
name. A tabc network is a directory (`internal/netreg`), and a
container on it is a file per name, holding an address that exists
only there and the address of the supervisor's relay. A guest that
looks up `redis` is answered from the directory. When it connects, its
supervisor hands the connection to redis's supervisor over a
WebSocket, and from there it is a connection in like any other.

## Volumes

A volume is a directory of the host. The page mounts it in the guest
as a file system that keeps no contents: every read and every change
is a request to the supervisor, which applies it through `os.Root`.
Init binds the mount to its place in the container. A single small
file is copied by content instead, as an engine's bound configuration
files are.

A path's attributes are kept, for at most a second. The guest asks for
them several times for one use of a file, and a directory's listing
already carries the attributes of every name in it, so the page keeps
what a listing brought and answers the questions that follow from
that. A name that is not there is kept as that answer too. A change
the guest makes drops everything kept, so the guest sees its own
changes at once. A change made on the host shows within about two
seconds: one for the page, and one more for the guest's kernel, which
keeps attributes that long on its own.

## Terminal

With runc the program holds one end of a pty and the engine the other.
Here the program's terminal is a pty inside the guest, which does the
line editing and the echo. The supervisor makes a pty on the host,
sends the controlling end to the engine over the console socket, puts
the other end in raw mode and copies bytes. A size the engine sets is
noticed by polling and passed to the guest.

## CPUs

The guest has two CPUs unless the container asks for a count: `--cpus`,
or a quota of CPU time in the bundle, rounded up to whole CPUs, and
never more than the host has threads or the kernel's 16. A limit below
one CPU is one CPU; nothing throttles the guest.

unkernel runs each CPU after the first in a Web Worker on shared
memory, and a CPU blocks while it waits for another, which a browser
allows in a worker and never on a page's main thread. So the guest and
everything that talks to the supervisor live in a worker of the page
(`page/guest.js`), and the page itself (`page/main.js`) only draws: the
name, the state, the terminal. The SDK can put the kernel in a worker
on its own, but then the network has to be one the SDK builds there,
and this guest's network is the supervisor.

A second CPU costs start-up time: `echo hi` takes 0.9 s on one CPU and
1.0 s on two on a Ryzen laptop. Four shells counting at once take 35 s
on one CPU, 22 s on two and 18 s on four on the laptop, and 22 s, 13 s
and 7 s on an M4.

Two things keep that cost to a tenth of a second, where it was 0.4 s.
The SDK carries the several-CPU kernel as a binary difference from the
one-CPU kernel and applies the difference in the page at every boot,
150 ms; tabc's build applies the difference once (`nix/unkernel.nix`)
and the page loads the result. And the guest boots with
`rcupdate.rcu_expedited=1`: its DHCP client at boot closes and binds
packet sockets, each call waits out an RCU grace period once a second
CPU is up, and the six calls took 190 ms. With the parameter a busy
guest ran no slower: forks, short connections, a 100 MB download and
installing packages were each within 6% either way on two CPUs.

## A page you can see

By default the supervisor starts a headless Chromium nobody sees. With
`--open` or `--link` it starts none: whichever browser loads the page
is the container. The page is a terminal (xterm.js), so what is typed
into it goes to the program, beside whatever the terminal tabc was
started from sends.

## tocker

On a Mac there is no engine for tabc to be a runtime of.
`internal/engine` is the part of one tabc then brings: containers,
networks, volumes, logs and events. `internal/dockerapi` puts the part
of Docker's API in front of it that `run`, `ps`, `logs`, `stop` and
Compose use. `tocker` starts that daemon and becomes the real `docker`
with `DOCKER_HOST` set.

With `--dashboard` the daemon starts no browsers. It serves one page
with a pane per container, and each pane's frame is the container.

## The walls

Between a program in the container and the host, in order:

1. The emulator and the kernel in the tab. A program that takes over
   the guest's kernel has taken over one WebAssembly instance.
2. WebAssembly in V8. Out of it is code execution in a renderer.
3. Chromium's renderer sandbox. Out of it is the browser's user.
4. That user. As root, tabc runs the browser as `nobody`.

Each container gets a browser of its own, with a profile of its own,
so two containers share no process and no storage. The supervisor's
server answers only requests that carry the container's token, and
serves a page nothing but that container's files.

The first wall is new code, and nobody has audited it. The next two
are the ones the web already leans on.

A container in a browser somebody opened has fewer walls: the browser
is the user's own, with their profile, on the host's network.

## A second program

`tabc exec` runs a program in a container that is already running. The
guest is reachable only through the page, so the request goes the way
a connection into the guest does: the command asks the supervisor over
the control socket, the supervisor asks the page, the page spawns init
with `--exec`, and answers on a WebSocket of its own.

Init does not build a root this time. The first init left the
container's root mounted where the whole guest can see it, and a file
that marks it finished. The second init waits for the file, enters the
same root, becomes the user and execs. There is no namespace to join:
the guest holds one container.

A user given by name (`-u app`) is looked up by that second init, in
the root it has just entered. The passwd file there is the running
container's, so a user added since the image was built is found.

By hand, the container is named by its id or by the name `tabc run
--name` gave it, and `tabc list` prints both for every container.

The control socket's connection stays open for the program's life and
carries its input, output and exit status as frames. The command that
asked is the program's process on the host. An engine passes
`--detach`, and then a child of the command stays in its place, named
in the pid file, so the engine has a process to wait on. A command
that goes away takes its program with it.

## What is missing

UDP, a CPU limit that throttles, checkpointing, building images without Docker.
x86-64 images, since the guest runs aarch64.

[unkernel]: https://github.com/pithings/unkernel
