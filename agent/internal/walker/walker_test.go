package walker

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"observer/agent/internal/rules"
)

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func collect(t *testing.T, root string, include, exclude []string) []string {
	t.Helper()
	compiled, err := rules.Compile(include, exclude, false)
	if err != nil {
		t.Fatal(err)
	}
	var rels []string
	err = New(root, compiled).Walk(context.Background(), func(entry Entry) error {
		if entry.SkipReason == "" {
			rels = append(rels, entry.Rel)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	return rels
}

func TestWalkFiltersAndPrunes(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "photos", "2024", "a.jpg"))
	writeFile(t, filepath.Join(root, "photos", "notes.txt"))
	writeFile(t, filepath.Join(root, "music", "b.jpg"))
	writeFile(t, filepath.Join(root, "loose.tmp"))

	got := collect(t, root, []string{"photos/**/*.jpg"}, []string{"**/*.tmp"})
	want := []string{"photos/2024/a.jpg"}
	if len(got) != len(want) || got[0] != want[0] {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestWalkWithoutInclude(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "a.txt"))
	writeFile(t, filepath.Join(root, "sub", "b.txt"))
	writeFile(t, filepath.Join(root, "skip.tmp"))

	got := collect(t, root, nil, []string{"**/*.tmp"})
	want := []string{"a.txt", "sub/b.txt"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestWalkSkipsSymlinks(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "real.txt"))
	target := filepath.Join(root, "real.txt")
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink not supported: %v", err)
	}

	compiled, err := rules.Compile(nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	var skips []string
	err = New(root, compiled).Walk(context.Background(), func(entry Entry) error {
		if entry.SkipReason == "symlink" {
			skips = append(skips, entry.Rel)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if len(skips) != 1 || skips[0] != "link.txt" {
		t.Fatalf("skips = %v", skips)
	}
}
