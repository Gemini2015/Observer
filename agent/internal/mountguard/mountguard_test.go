package mountguard

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCheckWithoutSentinel(t *testing.T) {
	dir := t.TempDir()
	status := Check(dir, "", "photos")
	if !status.OK {
		t.Fatalf("expected ok, got %s", status.Reason)
	}
}

func TestCheckSentinel(t *testing.T) {
	dir := t.TempDir()
	sentinel := filepath.Join(dir, ".observer-mount")
	if err := os.WriteFile(sentinel, []byte("mount_id=photos\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if status := Check(dir, ".observer-mount", "photos"); !status.OK {
		t.Fatalf("expected ok, got %s", status.Reason)
	}
	if status := Check(dir, ".observer-mount", "music"); status.OK {
		t.Fatal("expected sentinel mismatch to fail")
	}
	if status := Check(dir, ".missing-mount", "photos"); status.OK {
		t.Fatal("expected missing sentinel to fail")
	}
}

func TestCheckMissingRoot(t *testing.T) {
	status := Check(filepath.Join(t.TempDir(), "nope"), "", "photos")
	if status.OK {
		t.Fatal("expected missing root to fail")
	}
}
