package hashfile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSumFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "hello.txt")
	if err := os.WriteFile(path, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	chunks := 0
	bytesReported := 0
	sum, read, err := SumFile(path, make([]byte, 4), func(n int) error {
		chunks++
		bytesReported += n
		return nil
	})
	if err != nil {
		t.Fatalf("SumFile: %v", err)
	}

	const want = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	if sum != want {
		t.Errorf("hash = %s, want %s", sum, want)
	}
	if read != 5 || bytesReported != 5 {
		t.Errorf("read = %d, reported = %d", read, bytesReported)
	}
	if chunks != 2 {
		t.Errorf("chunks = %d, want 2", chunks)
	}
}

func TestSumFileMissing(t *testing.T) {
	_, _, err := SumFile(filepath.Join(t.TempDir(), "nope"), nil, nil)
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}
