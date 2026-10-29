package state

import (
	"path/filepath"
	"testing"
)

func TestCacheRoundTrip(t *testing.T) {
	cache, err := Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer cache.Close()

	if _, found, err := cache.Get("photos", "a.jpg"); err != nil || found {
		t.Fatalf("expected empty cache, found=%v err=%v", found, err)
	}

	entry := FileState{Size: 1024, MtimeNs: "1761234567890123456", HashedAt: 42}
	if err := cache.Put("photos", "a.jpg", entry); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, found, err := cache.Get("photos", "a.jpg")
	if err != nil || !found {
		t.Fatalf("Get: found=%v err=%v", found, err)
	}
	if got != entry {
		t.Errorf("got %+v, want %+v", got, entry)
	}

	if err := cache.PutBatch("photos", map[string]FileState{
		"b.jpg": {Size: 2},
		"c.jpg": {Size: 3},
	}); err != nil {
		t.Fatalf("PutBatch: %v", err)
	}
	count, err := cache.Count("photos")
	if err != nil {
		t.Fatalf("Count: %v", err)
	}
	if count != 3 {
		t.Errorf("count = %d, want 3", count)
	}

	if err := cache.Delete("photos", "a.jpg"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, found, _ := cache.Get("photos", "a.jpg"); found {
		t.Error("expected deleted entry to be gone")
	}

	meta := Meta{DBInstance: "db-1", Epoch: 7, FullSyncAt: 99}
	if err := cache.PutMeta("photos", meta); err != nil {
		t.Fatalf("PutMeta: %v", err)
	}
	gotMeta, found, err := cache.GetMeta("photos")
	if err != nil || !found {
		t.Fatalf("GetMeta: found=%v err=%v", found, err)
	}
	if gotMeta != meta {
		t.Errorf("meta = %+v, want %+v", gotMeta, meta)
	}

	if err := cache.ClearMount("photos"); err != nil {
		t.Fatalf("ClearMount: %v", err)
	}
	if count, _ := cache.Count("photos"); count != 0 {
		t.Errorf("count after clear = %d", count)
	}
}
