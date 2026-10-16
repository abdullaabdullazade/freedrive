package handlers

import (
	"mime"
	"strings"
	"testing"
)

func TestAttachmentDispositionRoundTripsFilenames(t *testing.T) {
	for _, name := range []string{"report.pdf", "季度 报告.txt", `say "hi".txt`, "naïve résumé.docx", "a;b=c.txt"} {
		value := attachmentDisposition(name)
		for _, c := range value {
			if c > 127 {
				t.Fatalf("%q: header is not ASCII: %q", name, value)
			}
		}
		disposition, params, err := mime.ParseMediaType(value)
		if err != nil || disposition != "attachment" || params["filename"] != name {
			t.Fatalf("%q: parsed %q %q (%v) from %q", name, disposition, params["filename"], err, value)
		}
	}
	if got := attachmentDisposition("季度.txt"); !strings.HasPrefix(got, "attachment; filename*=utf-8''") {
		t.Fatalf("non-ASCII names must use filename*: %q", got)
	}
}
