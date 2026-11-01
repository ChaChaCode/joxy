package main

import (
	"net/netip"
	"testing"
	"unsafe"
)

// Sizes and offsets of the 64-bit Windows SDK structs; a mismatch makes WFP read the wrong bytes without an error.
func TestLayoutMatchesTheSDK(t *testing.T) {
	var f filter
	var s session
	var sl sublayer
	var c condition
	checks := []struct {
		name      string
		got, want uintptr
	}{
		{"FWPM_SESSION0", unsafe.Sizeof(s), 72},
		{"FWPM_SESSION0.flags", unsafe.Offsetof(s.flags), 32},
		{"FWPM_SESSION0.sid", unsafe.Offsetof(s.sid), 48},
		{"FWPM_SESSION0.kernelMode", unsafe.Offsetof(s.kernelMode), 64},
		{"FWPM_SUBLAYER0", unsafe.Sizeof(sl), 72},
		{"FWPM_SUBLAYER0.providerKey", unsafe.Offsetof(sl.providerKey), 40},
		{"FWPM_SUBLAYER0.weight", unsafe.Offsetof(sl.weight), 64},
		{"FWP_VALUE0", unsafe.Sizeof(value{}), 16},
		{"FWPM_FILTER_CONDITION0", unsafe.Sizeof(c), 40},
		{"FWPM_FILTER_CONDITION0.conditionValue", unsafe.Offsetof(c.value), 24},
		{"FWPM_ACTION0", unsafe.Sizeof(action{}), 20},
		{"FWPM_FILTER0", unsafe.Sizeof(f), 200},
		{"FWPM_FILTER0.providerKey", unsafe.Offsetof(f.providerKey), 40},
		{"FWPM_FILTER0.layerKey", unsafe.Offsetof(f.layer), 64},
		{"FWPM_FILTER0.subLayerKey", unsafe.Offsetof(f.sublayer), 80},
		{"FWPM_FILTER0.weight", unsafe.Offsetof(f.weight), 96},
		{"FWPM_FILTER0.numFilterConditions", unsafe.Offsetof(f.numConditions), 112},
		{"FWPM_FILTER0.filterCondition", unsafe.Offsetof(f.conditions), 120},
		{"FWPM_FILTER0.action", unsafe.Offsetof(f.action), 128},
		{"FWPM_FILTER0.providerContextKey", unsafe.Offsetof(f.context), 152},
		{"FWPM_FILTER0.filterId", unsafe.Offsetof(f.id), 176},
		{"FWPM_FILTER0.effectiveWeight", unsafe.Offsetof(f.effectiveWeight), 184},
		{"FWP_V4_ADDR_AND_MASK", unsafe.Sizeof(v4AddrMask{}), 8},
		{"FWP_V6_ADDR_AND_MASK", unsafe.Sizeof(v6AddrMask{}), 17},
	}
	for _, check := range checks {
		if check.got != check.want {
			t.Errorf("%s: %d, the SDK has %d", check.name, check.got, check.want)
		}
	}
}

func TestPrefixesAreHostOrderMasks(t *testing.T) {
	k := &keep{}
	defer k.pinner.Unpin()
	m := (*v4AddrMask)(unsafe.Pointer(k.prefix(fieldRemoteAddress, netip.MustParsePrefix("192.168.1.7/16")).value.data))
	if m.addr != 0xc0a80000 || m.mask != 0xffff0000 {
		t.Errorf("192.168.0.0/16 became %08x/%08x", m.addr, m.mask)
	}
	m6 := (*v6AddrMask)(unsafe.Pointer(k.prefix(fieldRemoteAddress, netip.MustParsePrefix("fe80::1/10")).value.data))
	if m6.prefix != 10 || m6.addr[0] != 0xfe || m6.addr[1] != 0x80 || m6.addr[15] != 0 {
		t.Errorf("fe80::/10 became %x/%d", m6.addr, m6.prefix)
	}
}

func TestTunAliases(t *testing.T) {
	for alias, want := range map[string]bool{"JOXY": true, "joxy": true, "JOXY 2": true, "JOXY-2": false, "JOXYX": false, "JOXY 2a": false, "Ethernet": false} {
		if got := matchesTun(alias, "JOXY"); got != want {
			t.Errorf("%q: %v", alias, got)
		}
	}
}
