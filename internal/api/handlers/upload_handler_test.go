package handlers

import (
	"testing"
)

func TestContentRangeRegexp(t *testing.T) {
	cases := []struct {
		in    string
		ok    bool
		start int64
		end   int64
		total int64
	}{
		{"bytes 0-8388607/20000000", true, 0, 8388607, 20000000},
		{"BYTES 100-199/200", true, 100, 199, 200},
		{"bytes=0-10/100", false, 0, 0, 0},
		{"0-10/100", false, 0, 0, 0},
	}
	for _, c := range cases {
		m := contentRangeRe.FindStringSubmatch(c.in)
		if c.ok && m == nil {
			t.Fatalf("expected match for %q", c.in)
		}
		if !c.ok && m != nil {
			t.Fatalf("expected no match for %q", c.in)
		}
		if !c.ok {
			continue
		}
		// Parse checked in handler; ensure capture groups exist.
		if len(m) != 4 {
			t.Fatalf("want 4 groups, got %d for %q", len(m), c.in)
		}
	}
}
