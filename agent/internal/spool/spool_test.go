package spool

import (
	"path/filepath"
	"testing"

	"observer/agent/internal/hubclient"
)

func TestAppendReadReplace(t *testing.T) {
	queue, err := Open(filepath.Join(t.TempDir(), "spool.jsonl"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if err := queue.Append(Batch{JobID: 1, Seq: 1, Entries: []hubclient.Entry{{PathKey: "a", Status: "ok"}}}); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if err := queue.Append(Batch{JobID: 1, Seq: 2, Entries: []hubclient.Entry{{PathKey: "b", Status: "ok"}}}); err != nil {
		t.Fatalf("Append: %v", err)
	}

	batches, err := queue.ReadAll()
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if len(batches) != 2 || batches[0].Seq != 1 || batches[1].Seq != 2 {
		t.Fatalf("batches = %+v", batches)
	}

	if err := queue.Replace(batches[1:]); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	remaining, err := queue.ReadAll()
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if len(remaining) != 1 || remaining[0].Seq != 2 {
		t.Fatalf("remaining = %+v", remaining)
	}
}
