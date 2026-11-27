# The runtime end to end: a real headless Chromium boots the guest and
# runs programs from the example bundle. Each case replaces the
# bundle's program and checks what came back: the output, the exit
# status, the input.
{
  pkgs,
  tabc,
  bundle,
}:
pkgs.runCommand "tabc-e2e"
  {
    nativeBuildInputs = [
      tabc
      pkgs.jq
    ];
  }
  ''
    # A bundle of its own per case: the same root file system, and a
    # config.json with the case's program.
    run() {
      local name=$1
      shift
      mkdir -p bundles/$name
      ln -s ${bundle}/rootfs bundles/$name/rootfs
      # After "--" every word is the program's, "-c" included.
      jq '.process.args = $ARGS.positional' --args -- "$@" \
        < ${bundle}/config.json > bundles/$name/config.json
      tabc --root "$PWD/state" run --bundle bundles/$name $name
    }

    echo "output"
    test "$(run output echo hi < /dev/null)" = hi

    echo "exit status"
    status=0
    run status sh -c 'exit 7' < /dev/null || status=$?
    test "$status" = 7

    echo "stderr apart from stdout"
    run streams sh -c 'echo out; echo err >&2' < /dev/null > out.txt 2> err.txt
    test "$(cat out.txt)" = out
    test "$(cat err.txt)" = err

    echo "input, to its end"
    test "$(echo from the host | run input cat)" = "from the host"

    echo "a writable root over a read-only image"
    test "$(run writable sh -c 'echo x > /tmp/f && cat /tmp/f' < /dev/null)" = x

    # A volume: a directory of the host, bound into the container. The
    # page keeps a volume's attributes for a moment, so each change
    # the program makes is followed by a question that an attribute
    # kept from before the change would answer wrong: a size after an
    # append, a name after a rename and after a removal.
    echo "a volume: the host's file, and the program's own changes at once"
    mkdir -p bundles/volume volume
    ln -s ${bundle}/rootfs bundles/volume/rootfs
    echo from the host > volume/given
    volume() {
      local name=$1
      jq --arg source "$PWD/volume" '
        .process.args = ["sh", "-c", $ARGS.positional[0]]
        | .mounts = [{destination: "/v", type: "bind", source: $source, options: ["rbind", "rw"]}]
      ' --args -- "$2" < ${bundle}/config.json > bundles/volume/config.json
      tabc --root "$PWD/state" run --bundle bundles/volume $name < /dev/null
    }
    volume volume-own '
      cat /v/given
      ls -l /v > /dev/null
      test -e /v/made || echo absent
      echo 12345 > /v/made; stat -c %s /v/made
      echo abcde >> /v/made; stat -c %s /v/made
      mv /v/made /v/moved; ls /v
      test -e /v/made || echo renamed
      rm /v/moved; test -e /v/moved || echo removed
      echo from the guest > /v/left
    ' > volume.txt
    printf '%s\n' "from the host" absent 6 12 given moved renamed removed > wanted.txt
    cmp volume.txt wanted.txt
    test "$(cat volume/left)" = "from the guest"

    # A change made on the host is one the page is not told of, so a
    # kept attribute has to run out by itself. The program says through
    # the volume that it is about to ask, then asks for a name that is
    # not there, which the page keeps as the answer. The host makes the
    # name half a second after the program spoke: after the question,
    # and before the kept answer runs out. The program gives up after
    # ten seconds, so a kept answer that never runs out fails here and
    # does not hang the build.
    echo "a volume: a change made on the host, seen in time"
    (
      until [ -e volume/asking ]; do
        sleep 0.1
      done
      sleep 0.5
      touch volume/late
    ) &
    test "$(volume volume-host '
      echo x > /v/asking
      tries=0
      until [ -e /v/late ] || [ $tries -ge 100 ]; do
        sleep 0.1
        tries=$((tries + 1))
      done
      test -e /v/late && echo seen || echo never
    ')" = seen
    wait

    echo "the guest is its own machine"
    test "$(run machine uname -m < /dev/null)" = aarch64

    # A quota of two CPUs' time is a guest with two CPUs, where the
    # machine that builds this has two threads to give.
    echo "CPUs"
    mkdir -p bundles/cpus
    ln -s ${bundle}/rootfs bundles/cpus/rootfs
    jq '.process.args = ["nproc"] | .linux.resources.cpu = {quota: 200000, period: 100000}' \
      < ${bundle}/config.json > bundles/cpus/config.json
    wanted=2
    if [ "$(nproc)" -lt 2 ]; then
      wanted=1
    fi
    test "$(tabc --root "$PWD/state" run --bundle bundles/cpus cpus < /dev/null)" = "$wanted"

    # The guest's kernel is booted to end an RCU grace period at once,
    # and the kernel reports as much in /sys.
    echo "expedited grace periods"
    test "$(run expedited cat /sys/kernel/rcu_expedited < /dev/null)" = 1

    # A second program in a container that is running. The container's
    # own program leaves a file and waits; each exec is checked the way
    # a container's program was above.
    echo "exec"
    mkdir -p bundles/long
    ln -s ${bundle}/rootfs bundles/long/rootfs
    jq '.process.args = ["sh", "-c", "echo first > /tmp/left; sleep 300"]' \
      < ${bundle}/config.json > bundles/long/config.json
    tabc --root "$PWD/state" run --bundle bundles/long long < /dev/null &
    until tabc --root "$PWD/state" state long 2>/dev/null | jq -e '.status == "running"' > /dev/null; do
      sleep 0.1
    done
    inside() {
      tabc --root "$PWD/state" exec "$@"
    }

    # Running is when the container's program was started, which is a
    # moment before the program has left its file.
    echo "exec: the container's files"
    until inside long test -f /tmp/left; do
      sleep 0.1
    done
    test "$(inside long cat /tmp/left)" = first

    echo "exec: exit status"
    status=0
    inside long sh -c 'exit 9' || status=$?
    test "$status" = 9

    echo "exec: input, to its end"
    test "$(echo to the second | inside -i long cat)" = "to the second"

    echo "exec: environment, directory and user"
    test "$(inside -e WORD=x -w /tmp -u 5:6 long sh -c 'echo $WORD $PWD $(id -u):$(id -g)')" = "x /tmp 5:6"

    # A user by name is looked up in the running container, so a user
    # the container gained after its start is found, and one nobody
    # added is refused.
    echo "exec: a user added since the start, by name"
    inside long sh -c 'echo "late:x:1234:1235::/:/bin/sh" >> /etc/passwd'
    test "$(inside -u late long sh -c 'echo $(id -u):$(id -g)')" = "1234:1235"
    if inside -u nobody-here long true 2> /dev/null; then
      echo "a user nobody added ran a program" >&2
      exit 1
    fi

    echo "list"
    tabc --root "$PWD/state" list | grep -q '^long .* running '

    echo "exec: a program that is not there"
    status=0
    inside long no-such-program 2> /dev/null || status=$?
    test "$status" = 127

    tabc --root "$PWD/state" kill long KILL
    wait

    touch $out
  ''
