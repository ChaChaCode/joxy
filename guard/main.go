// joxy-guard is JOXY's kill switch. JOXY starts it with administrator rights while a TUN session is meant to be up,
// writes one JSON line of configuration to its stdin, and keeps stdin open for as long as traffic outside the
// tunnel must stay blocked. The filters live in a dynamic WFP session, so Windows drops them as soon as this
// process ends for any reason: closed stdin, JOXY exiting, or a crash. Blocking can never outlive JOXY.
//
// Stdout is a line protocol: READY, ERROR <message>, WARN <message>.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/windows"
)

type config struct {
	// Executables whose own connections pass: the Xray core, which carries the tunnel.
	Apps []string `json:"apps"`
	// Alias of the TUN adapter; it may appear, vanish and come back with a new LUID while the guard runs.
	Tun string `json:"tun"`
	// Private and link-local destinations pass, except DNS: a router would forward it outside the tunnel.
	AllowLAN bool `json:"allowLan"`
}

var output sync.Mutex

func say(kind, message string) {
	output.Lock()
	defer output.Unlock()
	message = strings.NewReplacer("\r", " ", "\n", " ").Replace(message)
	fmt.Fprintln(os.Stdout, strings.TrimSpace(kind+" "+message))
}

func readConfig(input *bufio.Reader) (*config, error) {
	line := make(chan string, 1)
	go func() { text, _ := input.ReadString('\n'); line <- text }()
	select {
	case text := <-line:
		var cfg config
		if err := json.Unmarshal([]byte(text), &cfg); err != nil {
			return nil, fmt.Errorf("invalid configuration: %w", err)
		}
		if cfg.Tun == "" || len(cfg.Tun) > 64 || strings.ContainsAny(cfg.Tun, "\x00") {
			return nil, errors.New("invalid TUN adapter name")
		}
		if len(cfg.Apps) == 0 || len(cfg.Apps) > 8 {
			return nil, errors.New("one to eight permitted executables are required")
		}
		for _, app := range cfg.Apps {
			if !filepath.IsAbs(app) {
				return nil, fmt.Errorf("permitted executable %q is not an absolute path", app)
			}
		}
		return &cfg, nil
	case <-time.After(10 * time.Second):
		return nil, errors.New("no configuration received")
	}
}

// waitParent returns when the process with that PID ends; a handle pins it against PID reuse.
func waitParent(pid int) {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(handle)
	windows.WaitForSingleObject(handle, windows.INFINITE)
}

func main() {
	parent := flag.Int("parent", 0, "PID of JOXY; the guard exits with it")
	findOnly := flag.String("find-tun", "", "print the LUIDs the guard would permit for this adapter name, then exit")
	flag.Parse()
	if *findOnly != "" {
		luids, err := findTun(*findOnly)
		if err != nil {
			say("ERROR", err.Error())
			os.Exit(1)
		}
		for _, luid := range luids {
			fmt.Println(luid)
		}
		return
	}
	if *parent <= 0 {
		say("ERROR", "the parent PID is required")
		os.Exit(1)
	}
	if !windows.GetCurrentProcessToken().IsElevated() {
		say("ERROR", "the kill switch needs administrator rights")
		os.Exit(1)
	}
	input := bufio.NewReader(os.Stdin)
	cfg, err := readConfig(input)
	if err != nil {
		say("ERROR", err.Error())
		os.Exit(1)
	}
	guard, err := arm(cfg)
	if err != nil {
		say("ERROR", err.Error())
		os.Exit(1)
	}
	say("READY", "")

	done := make(chan struct{}, 3)
	go func() { _, _ = io.Copy(io.Discard, input); done <- struct{}{} }()
	go func() { waitParent(*parent); done <- struct{}{} }()
	go guard.followTun(done)
	<-done
	// Closing the engine would happen at exit anyway; doing it first keeps the order explicit.
	guard.close()
}
