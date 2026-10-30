package main

import (
	"fmt"
	"path/filepath"
	"testing"

	"observer/agent/internal/config"
)

func TestFileServiceMountsAndConnectionErrors(t *testing.T) {
	mountDir := t.TempDir()
	raw := fmt.Sprintf(`agent:
  machine_id: test-pc
  hub: http://127.0.0.1:8787
  token: token-abc
mounts:
  - id: data
    label: Data
    path: %s
`, filepath.ToSlash(mountDir))
	cfg, err := config.Parse([]byte(raw))
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}

	service := &FileService{controller: &controller{cfg: cfg}}
	mounts, err := service.Mounts()
	if err != nil {
		t.Fatalf("Mounts: %v", err)
	}
	if len(mounts) != 1 || mounts[0].ID != "data" || mounts[0].Label != "Data" {
		t.Fatalf("unexpected mounts: %+v", mounts)
	}

	if _, err := service.ListFiles(FileQuery{}); err == nil {
		t.Fatal("expected error when runner is not initialized")
	}
	if _, err := service.FileDetail(1); err == nil {
		t.Fatal("expected error when runner is not initialized")
	}
}
