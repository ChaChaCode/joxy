package main

import (
	"cmp"
	"errors"
	"fmt"
	"net/netip"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Bindings to fwpuclnt.dll. The structs mirror fwptypes.h/fwpmtypes.h for 64-bit Windows field by field;
// layout_test.go checks every size and offset against the SDK, since a shifted field fails silently.

var (
	fwpuclnt                 = windows.NewLazySystemDLL("fwpuclnt.dll")
	procEngineOpen           = fwpuclnt.NewProc("FwpmEngineOpen0")
	procEngineClose          = fwpuclnt.NewProc("FwpmEngineClose0")
	procTransactionBegin     = fwpuclnt.NewProc("FwpmTransactionBegin0")
	procTransactionCommit    = fwpuclnt.NewProc("FwpmTransactionCommit0")
	procTransactionAbort     = fwpuclnt.NewProc("FwpmTransactionAbort0")
	procSubLayerAdd          = fwpuclnt.NewProc("FwpmSubLayerAdd0")
	procFilterAdd            = fwpuclnt.NewProc("FwpmFilterAdd0")
	procFilterDeleteByID     = fwpuclnt.NewProc("FwpmFilterDeleteById0")
	procGetAppIDFromFileName = fwpuclnt.NewProc("FwpmGetAppIdFromFileName0")
	procFreeMemory           = fwpuclnt.NewProc("FwpmFreeMemory0")
)

const (
	rpcAuthnWinNT          = 10
	sessionFlagDynamic     = 1
	typeUint8              = 1
	typeUint16             = 2
	typeUint32             = 3
	typeUint64             = 4
	typeByteBlob           = 12
	typeSecurityDescriptor = 14
	typeV4AddrMask         = 0x100
	typeV6AddrMask         = 0x101
	matchEqual             = 0
	matchFlagsAllSet       = 6
	conditionFlagLoopback  = 1
	actionBlock            = 0x1001
	actionPermit           = 0x1002
	protocolTCP            = 6
	protocolUDP            = 17
	protocolICMPv6         = 58
)

var (
	layerConnectV4 = windows.GUID{Data1: 0xc38d57d1, Data2: 0x05a7, Data3: 0x4c33, Data4: [8]byte{0x90, 0x4f, 0x7f, 0xbc, 0xee, 0xe6, 0x0e, 0x82}}
	layerConnectV6 = windows.GUID{Data1: 0x4a72393b, Data2: 0x319f, Data3: 0x44bc, Data4: [8]byte{0x84, 0xc3, 0xba, 0x54, 0xdc, 0xb3, 0xb6, 0xb4}}
	layerAcceptV4  = windows.GUID{Data1: 0xe1cd9fe7, Data2: 0xf4b5, Data3: 0x4273, Data4: [8]byte{0x96, 0xc0, 0x59, 0x2e, 0x48, 0x7b, 0x86, 0x50}}
	layerAcceptV6  = windows.GUID{Data1: 0xa3b42c97, Data2: 0x9f04, Data3: 0x4672, Data4: [8]byte{0xb8, 0x7e, 0xce, 0xe9, 0xc4, 0x83, 0x25, 0x7f}}

	fieldFlags          = windows.GUID{Data1: 0x632ce23b, Data2: 0x5167, Data3: 0x435c, Data4: [8]byte{0x86, 0xd7, 0xe9, 0x03, 0x68, 0x4a, 0xa8, 0x0c}}
	fieldLocalInterface = windows.GUID{Data1: 0x4cd62a49, Data2: 0x59c3, Data3: 0x4969, Data4: [8]byte{0xb7, 0xf3, 0xbd, 0xa5, 0xd3, 0x28, 0x90, 0xa4}}
	fieldLocalPort      = windows.GUID{Data1: 0x0c1ba1af, Data2: 0x5765, Data3: 0x453f, Data4: [8]byte{0xaf, 0x22, 0xa8, 0xf7, 0x91, 0xac, 0x77, 0x5b}}
	fieldProtocol       = windows.GUID{Data1: 0x3971ef2b, Data2: 0x623e, Data3: 0x4f9a, Data4: [8]byte{0x8c, 0xb1, 0x6e, 0x79, 0xb8, 0x06, 0xb9, 0xa7}}
	fieldRemoteAddress  = windows.GUID{Data1: 0xb235ae9a, Data2: 0x1d64, Data3: 0x49b8, Data4: [8]byte{0xa4, 0x4c, 0x5f, 0xf3, 0xd9, 0x09, 0x50, 0x45}}
	fieldRemotePort     = windows.GUID{Data1: 0xc35a604d, Data2: 0xd22b, Data3: 0x4e1a, Data4: [8]byte{0x91, 0xb4, 0x68, 0xf6, 0x74, 0xee, 0x67, 0x4b}}
	fieldAppID          = windows.GUID{Data1: 0xd78e1e87, Data2: 0x8644, Data3: 0x4ea5, Data4: [8]byte{0x94, 0x37, 0xd8, 0x09, 0xec, 0xef, 0xc9, 0x71}}
	fieldUserID         = windows.GUID{Data1: 0xaf043a0a, Data2: 0xb34d, Data3: 0x4f86, Data4: [8]byte{0x97, 0x9c, 0xc9, 0x03, 0x71, 0xaf, 0x6e, 0x66}}
)

// The service SID Windows gives the DNS Client service (Dnscache) in its token.
const dnsClientSID = "S-1-5-80-859482183-879914841-863379149-1145462774-2388618682"

type displayData struct{ name, description *uint16 }

type session struct {
	key            windows.GUID
	display        displayData
	flags          uint32
	txnWaitTimeout uint32
	processID      uint32
	_              uint32
	sid            *windows.SID
	username       *uint16
	kernelMode     int32
	_              uint32
}

type byteBlob struct {
	size uint32
	_    uint32
	data *byte
}

type sublayer struct {
	key          windows.GUID
	display      displayData
	flags        uint32
	_            uint32
	providerKey  *windows.GUID
	providerData byteBlob
	weight       uint16
	_            [6]byte
}

// FWP_VALUE0 and FWP_CONDITION_VALUE0: up to 32 bits sit in data, wider values are pointers.
type value struct {
	typ  uint32
	_    uint32
	data uintptr
}

type condition struct {
	field windows.GUID
	match uint32
	_     uint32
	value value
}

type action struct {
	typ uint32
	key windows.GUID
}

type filter struct {
	key             windows.GUID
	display         displayData
	flags           uint32
	_               uint32
	providerKey     *windows.GUID
	providerData    byteBlob
	layer           windows.GUID
	sublayer        windows.GUID
	weight          value
	numConditions   uint32
	_               uint32
	conditions      *condition
	action          action
	_               uint32
	context         [2]uint64
	reserved        *windows.GUID
	id              uint64
	effectiveWeight value
}

type v4AddrMask struct{ addr, mask uint32 }

type v6AddrMask struct {
	addr   [16]byte
	prefix uint8
}

// WFP functions return their error code instead of setting the thread's last error.
func call(proc *windows.LazyProc, args ...uintptr) error {
	if r, _, _ := proc.Call(args...); r != 0 {
		return windows.Errno(r)
	}
	return nil
}

func utf16(text string) *uint16 { p, _ := windows.UTF16PtrFromString(text); return p }

// rule is one filter, installed on each of its layers. Conditions on the same field are ORed, different fields ANDed.
type rule struct {
	name       string
	layers     []windows.GUID
	weight     uint8
	action     uint32
	conditions []condition
}

var (
	allLayers     = []windows.GUID{layerConnectV4, layerConnectV6, layerAcceptV4, layerAcceptV6}
	connectLayers = []windows.GUID{layerConnectV4, layerConnectV6}
	v6Layers      = []windows.GUID{layerConnectV6, layerAcceptV6}
	lan4          = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("172.16.0.0/12"), netip.MustParsePrefix("192.168.0.0/16"), netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("224.0.0.0/4"), netip.MustParsePrefix("255.255.255.255/32")}
	lan6          = []netip.Prefix{netip.MustParsePrefix("fe80::/10"), netip.MustParsePrefix("fc00::/7"), netip.MustParsePrefix("ff00::/8")}
	link6         = []netip.Prefix{netip.MustParsePrefix("fe80::/10"), netip.MustParsePrefix("ff02::/16")}
)

// Weights order the rules inside our sublayer: the highest matching one decides there.
const (
	weightApps     = 15
	weightTun      = 14
	weightLoopback = 13
	weightLANDNS   = 12
	weightLAN      = 11
	weightLink     = 10
	weightDNS      = 2
	weightBlock    = 0
)

// Some systems refuse to commit a WFP transaction of more than five filters, failing with FWP_E_IN_USE ("The object
// is referenced by other objects"), whatever the filters are. Filters therefore go in in batches of this size,
// permits before blocks, so no moment between two batches blocks more than the finished set would. If a batch fails,
// closing the dynamic session takes the batches already committed with it.
const batchSize = 5

type guard struct {
	mu       sync.Mutex
	engine   uintptr
	sublayer windows.GUID
	tunName  string
	tunLUIDs []uint64
	tunIDs   []uint64
}

// keep pins every value a condition points to until the transaction that uses it is over.
type keep struct{ pinner runtime.Pinner }

func (k *keep) ptr(p unsafe.Pointer) uintptr { k.pinner.Pin(p); return uintptr(p) }

func (k *keep) uint8(field windows.GUID, v uint8) condition {
	return condition{field: field, match: matchEqual, value: value{typ: typeUint8, data: uintptr(v)}}
}

func (k *keep) uint16(field windows.GUID, v uint16) condition {
	return condition{field: field, match: matchEqual, value: value{typ: typeUint16, data: uintptr(v)}}
}

func (k *keep) uint64(field windows.GUID, v uint64) condition {
	p := new(uint64)
	*p = v
	return condition{field: field, match: matchEqual, value: value{typ: typeUint64, data: k.ptr(unsafe.Pointer(p))}}
}

func (k *keep) prefix(field windows.GUID, prefix netip.Prefix) condition {
	prefix = prefix.Masked()
	if prefix.Addr().Is4() {
		a := prefix.Addr().As4()
		m := &v4AddrMask{addr: uint32(a[0])<<24 | uint32(a[1])<<16 | uint32(a[2])<<8 | uint32(a[3]), mask: ^uint32(0) << (32 - prefix.Bits())}
		if prefix.Bits() == 0 {
			m.mask = 0
		}
		return condition{field: field, match: matchEqual, value: value{typ: typeV4AddrMask, data: k.ptr(unsafe.Pointer(m))}}
	}
	m := &v6AddrMask{addr: prefix.Addr().As16(), prefix: uint8(prefix.Bits())}
	return condition{field: field, match: matchEqual, value: value{typ: typeV6AddrMask, data: k.ptr(unsafe.Pointer(m))}}
}

func (k *keep) prefixes(field windows.GUID, list []netip.Prefix) []condition {
	out := make([]condition, len(list))
	for i, p := range list {
		out[i] = k.prefix(field, p)
	}
	return out
}

func arm(cfg *config) (*guard, error) {
	g := &guard{tunName: cfg.Tun}
	name := "JOXY kill switch"
	if cfg.LeaksOnly {
		name = "JOXY leak protection"
	}
	s := session{display: displayData{name: utf16(name)}, flags: sessionFlagDynamic, txnWaitTimeout: 10000}
	if err := call(procEngineOpen, 0, rpcAuthnWinNT, 0, uintptr(unsafe.Pointer(&s)), uintptr(unsafe.Pointer(&g.engine))); err != nil {
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return nil, fmt.Errorf("the filtering engine refused access: %w", err)
		}
		return nil, fmt.Errorf("the Base Filtering Engine is unavailable: %w", err)
	}
	apps, err := appIDs(cfg.Apps)
	defer func() {
		for _, blob := range apps {
			procFreeMemory.Call(uintptr(unsafe.Pointer(&blob)))
		}
	}()
	if err != nil {
		g.close()
		return nil, err
	}
	luids, err := findTun(cfg.Tun)
	if err != nil {
		g.close()
		return nil, err
	}
	k := &keep{}
	defer k.pinner.Unpin()
	if g.sublayer, err = windows.GenerateGUID(); err != nil {
		g.close()
		return nil, err
	}
	err = g.transaction(func() error {
		sl := sublayer{key: g.sublayer, display: displayData{name: utf16(name)}, weight: 0xffff}
		if err := call(procSubLayerAdd, g.engine, uintptr(unsafe.Pointer(&sl)), 0); err != nil {
			return fmt.Errorf("add the sublayer: %w", err)
		}
		return nil
	})
	// The tunnel's permit goes in first; the other rules follow with their permits ahead of their blocks.
	if err == nil {
		g.tunIDs, err = g.install(tunRules(k, luids))
	}
	if err == nil {
		rules := baseRules(k, cfg, apps)
		if cfg.LeaksOnly {
			rules, err = leakRules(k, cfg, apps)
		}
		if err == nil {
			_, err = g.install(permitsFirst(rules))
		}
	}
	if err != nil {
		g.close()
		return nil, fmt.Errorf("install the filters: %w", err)
	}
	g.tunLUIDs = luids
	return g, nil
}

func appIDs(paths []string) ([]*byteBlob, error) {
	var blobs []*byteBlob
	for _, path := range paths {
		var blob *byteBlob
		if err := call(procGetAppIDFromFileName, uintptr(unsafe.Pointer(utf16(path))), uintptr(unsafe.Pointer(&blob))); err != nil {
			return blobs, fmt.Errorf("resolve the app ID of %s: %w", path, err)
		}
		blobs = append(blobs, blob)
	}
	return blobs, nil
}

func baseRules(k *keep, cfg *config, apps []*byteBlob) []rule {
	var permitted []condition
	for _, blob := range apps {
		permitted = append(permitted, condition{field: fieldAppID, match: matchEqual, value: value{typ: typeByteBlob, data: uintptr(unsafe.Pointer(blob))}})
	}
	udp := k.uint8(fieldProtocol, protocolUDP)
	rules := []rule{
		{"permit the core", allLayers, weightApps, actionPermit, permitted},
		{"permit loopback", allLayers, weightLoopback, actionPermit, []condition{{field: fieldFlags, match: matchFlagsAllSet, value: value{typ: typeUint32, data: conditionFlagLoopback}}}},
		// The physical adapter keeps its lease, so the tunnel can come back.
		{"permit DHCP", []windows.GUID{layerConnectV4, layerAcceptV4}, weightLink, actionPermit, []condition{udp, k.uint16(fieldLocalPort, 68), k.uint16(fieldRemotePort, 67)}},
		{"permit DHCPv6", []windows.GUID{layerConnectV6, layerAcceptV6}, weightLink, actionPermit, []condition{udp, k.uint16(fieldLocalPort, 546), k.uint16(fieldRemotePort, 547)}},
		{"permit neighbor discovery", []windows.GUID{layerConnectV6, layerAcceptV6}, weightLink, actionPermit, append([]condition{k.uint8(fieldProtocol, protocolICMPv6)}, k.prefixes(fieldRemoteAddress, link6)...)},
		{"block everything else", allLayers, weightBlock, actionBlock, nil},
	}
	if cfg.AllowLAN {
		dns := []condition{k.uint16(fieldRemotePort, 53), k.uint16(fieldRemotePort, 853)}
		rules = append(rules,
			rule{"block DNS to the LAN", []windows.GUID{layerConnectV4}, weightLANDNS, actionBlock, append(k.prefixes(fieldRemoteAddress, lan4), dns...)},
			rule{"block DNS to the LAN", []windows.GUID{layerConnectV6}, weightLANDNS, actionBlock, append(k.prefixes(fieldRemoteAddress, lan6), dns...)},
			rule{"permit the LAN", []windows.GUID{layerConnectV4, layerAcceptV4}, weightLAN, actionPermit, k.prefixes(fieldRemoteAddress, lan4)},
			rule{"permit the LAN", []windows.GUID{layerConnectV6, layerAcceptV6}, weightLAN, actionPermit, k.prefixes(fieldRemoteAddress, lan6)},
		)
	}
	return rules
}

// leakRules keep only leaks inside the tunnel instead of all traffic. With BlockDNS, connections to the ports of DNS,
// DNS over TLS and DNS over QUIC, and from Windows 11 on the DNS Client service, which may also query over HTTPS to
// any port, may not leave through another interface: Windows sends a query to the servers of every interface, an
// on-link resolver such as the router included. With BlockIPv6 nothing of IPv6 leaves either, for a tunnel that
// carries none.
func leakRules(k *keep, cfg *config, apps []*byteBlob) ([]rule, error) {
	var permitted []condition
	for _, blob := range apps {
		permitted = append(permitted, condition{field: fieldAppID, match: matchEqual, value: value{typ: typeByteBlob, data: uintptr(unsafe.Pointer(blob))}})
	}
	dns := []condition{k.uint8(fieldProtocol, protocolUDP), k.uint8(fieldProtocol, protocolTCP), k.uint16(fieldRemotePort, 53), k.uint16(fieldRemotePort, 853)}
	rules := []rule{
		{"permit the core", allLayers, weightApps, actionPermit, permitted},
		{"permit loopback", allLayers, weightLoopback, actionPermit, []condition{{field: fieldFlags, match: matchFlagsAllSet, value: value{typ: typeUint32, data: conditionFlagLoopback}}}},
	}
	if cfg.BlockDNS {
		rules = append(rules, rule{"block DNS outside the tunnel", connectLayers, weightDNS, actionBlock, dns})
	}
	if _, _, build := windows.RtlGetNtVersionNumbers(); cfg.BlockDNS && build >= 20348 {
		client, err := k.service(dnsClientSID)
		if err != nil {
			return nil, err
		}
		// mDNS and LLMNR stay on the local link.
		rules = append(rules,
			rule{"permit the DNS Client service's mDNS and LLMNR", connectLayers, weightLAN, actionPermit, []condition{client, k.uint16(fieldRemotePort, 5353), k.uint16(fieldRemotePort, 5355)}},
			rule{"block the DNS Client service outside the tunnel", connectLayers, weightDNS, actionBlock, []condition{client}},
		)
	}
	if cfg.BlockIPv6 {
		udp := k.uint8(fieldProtocol, protocolUDP)
		rules = append(rules,
			rule{"permit DHCPv6", v6Layers, weightLink, actionPermit, []condition{udp, k.uint16(fieldLocalPort, 546), k.uint16(fieldRemotePort, 547)}},
			rule{"permit neighbor discovery", v6Layers, weightLink, actionPermit, append([]condition{k.uint8(fieldProtocol, protocolICMPv6)}, k.prefixes(fieldRemoteAddress, link6)...)},
			rule{"block IPv6", v6Layers, weightBlock, actionBlock, nil},
		)
	}
	return rules, nil
}

// service matches connections of the service with that SID: the descriptor grants it the right to match.
func (k *keep) service(sid string) (condition, error) {
	sd, err := windows.SecurityDescriptorFromString("O:SYG:SYD:(A;;CCRC;;;" + sid + ")")
	if err != nil {
		return condition{}, err
	}
	blob := &byteBlob{size: sd.Length(), data: (*byte)(unsafe.Pointer(sd))}
	k.pinner.Pin(sd)
	return condition{field: fieldUserID, match: matchEqual, value: value{typ: typeSecurityDescriptor, data: k.ptr(unsafe.Pointer(blob))}}, nil
}

func tunRules(k *keep, luids []uint64) []rule {
	if len(luids) == 0 {
		return nil
	}
	var local []condition
	for _, luid := range luids {
		local = append(local, k.uint64(fieldLocalInterface, luid))
	}
	return []rule{{"permit the tunnel", allLayers, weightTun, actionPermit, local}}
}

func permitsFirst(rules []rule) []rule {
	out := slices.Clone(rules)
	slices.SortStableFunc(out, func(a, b rule) int {
		return cmp.Compare(boolInt(a.action != actionPermit), boolInt(b.action != actionPermit))
	})
	return out
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (g *guard) transaction(fn func() error) error {
	if err := call(procTransactionBegin, g.engine, 0); err != nil {
		return fmt.Errorf("begin a transaction: %w", err)
	}
	if err := fn(); err != nil {
		procTransactionAbort.Call(g.engine)
		return err
	}
	if err := call(procTransactionCommit, g.engine); err != nil {
		procTransactionAbort.Call(g.engine)
		return fmt.Errorf("commit the transaction: %w", err)
	}
	return nil
}

// install adds the rules in order, in transactions of at most batchSize filters, and returns the filter IDs.
func (g *guard) install(rules []rule) ([]uint64, error) {
	var pinner runtime.Pinner
	defer pinner.Unpin()
	var filters []filter
	var names []string
	for _, r := range rules {
		for _, layer := range r.layers {
			f := filter{
				display:  displayData{name: utf16("JOXY: " + r.name)},
				layer:    layer,
				sublayer: g.sublayer,
				weight:   value{typ: typeUint8, data: uintptr(r.weight)},
				action:   action{typ: r.action},
			}
			if len(r.conditions) > 0 {
				f.numConditions = uint32(len(r.conditions))
				f.conditions = &r.conditions[0]
				pinner.Pin(f.conditions)
			}
			filters = append(filters, f)
			names = append(names, r.name)
		}
	}
	var ids []uint64
	for batch := range slices.Chunk(filters, batchSize) {
		err := g.transaction(func() error {
			for i := range batch {
				var id uint64
				if err := call(procFilterAdd, g.engine, uintptr(unsafe.Pointer(&batch[i])), 0, uintptr(unsafe.Pointer(&id))); err != nil {
					return fmt.Errorf("add the filter %q: %w", names[len(ids)], err)
				}
				ids = append(ids, id)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	runtime.KeepAlive(rules)
	return ids, nil
}

// remove deletes filters in transactions of at most batchSize.
func (g *guard) remove(ids []uint64) error {
	for batch := range slices.Chunk(ids, batchSize) {
		err := g.transaction(func() error {
			for _, id := range batch {
				if err := call(procFilterDeleteByID, g.engine, uintptr(id)); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// findTun returns the LUIDs of adapters named like the TUN; Windows calls a second instance "JOXY 2".
func findTun(name string) ([]uint64, error) {
	size := uint32(16 * 1024)
	var buf []byte
	for attempt := 0; attempt < 4; attempt++ {
		buf = make([]byte, size)
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, windows.GAA_FLAG_INCLUDE_ALL_INTERFACES|windows.GAA_FLAG_SKIP_DNS_SERVER|windows.GAA_FLAG_SKIP_MULTICAST|windows.GAA_FLAG_SKIP_ANYCAST, 0, (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])), &size)
		if err == nil {
			break
		}
		if !errors.Is(err, windows.ERROR_BUFFER_OVERFLOW) {
			return nil, fmt.Errorf("list network adapters: %w", err)
		}
		buf = nil
	}
	if buf == nil {
		return nil, errors.New("list network adapters: the list keeps growing")
	}
	var luids []uint64
	for a := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])); a != nil; a = a.Next {
		if matchesTun(windows.UTF16PtrToString(a.FriendlyName), name) {
			luids = append(luids, a.Luid)
		}
	}
	slices.Sort(luids)
	return slices.Compact(luids), nil
}

func matchesTun(alias, name string) bool {
	if strings.EqualFold(alias, name) {
		return true
	}
	rest, ok := strings.CutPrefix(strings.ToLower(alias), strings.ToLower(name)+" ")
	_, err := strconv.ParseUint(rest, 10, 16)
	return ok && err == nil
}

// followTun swaps the tunnel permit whenever the adapter is created again with a new LUID.
func (g *guard) followTun(done chan<- struct{}) {
	for range time.Tick(300 * time.Millisecond) {
		luids, err := findTun(g.tunName)
		if err != nil {
			continue
		}
		g.mu.Lock()
		if !slices.Equal(luids, g.tunLUIDs) {
			// The new permit goes in before the old one goes out, so the tunnel is never blocked in between.
			k := &keep{}
			ids, err := g.install(tunRules(k, luids))
			k.pinner.Unpin()
			if err == nil {
				if err = g.remove(g.tunIDs); err != nil {
					err = fmt.Errorf("remove the old tunnel permit: %w", err)
				}
				g.tunLUIDs, g.tunIDs = luids, ids
			}
			if err != nil {
				say("WARN", err.Error())
			}
		}
		g.mu.Unlock()
	}
	done <- struct{}{}
}

// Closing a dynamic session makes the Base Filtering Engine delete everything added through it.
func (g *guard) close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.engine != 0 {
		procEngineClose.Call(g.engine)
		g.engine = 0
	}
}
