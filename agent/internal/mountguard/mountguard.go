// Package mountguard 做巡检前的挂载点可用性校验：目录可达 + sentinel 匹配。
package mountguard

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Status 是检查结果。
type Status struct {
	OK     bool
	Reason string
}

// Check 校验 root 可访问且 sentinel（若配置）包含 mountID。
func Check(root, sentinel, mountID string) Status {
	info, err := os.Stat(root)
	if err != nil {
		return Status{Reason: fmt.Sprintf("root not accessible: %v", err)}
	}
	if !info.IsDir() {
		return Status{Reason: "root is not a directory"}
	}

	dir, err := os.Open(root)
	if err != nil {
		return Status{Reason: fmt.Sprintf("root not readable: %v", err)}
	}
	_, readErr := dir.Readdirnames(1)
	_ = dir.Close()
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return Status{Reason: fmt.Sprintf("root not listable: %v", readErr)}
	}

	if sentinel != "" {
		path := filepath.Join(root, filepath.FromSlash(sentinel))
		data, err := os.ReadFile(path)
		if err != nil {
			return Status{Reason: fmt.Sprintf("sentinel missing: %v", err)}
		}
		if !strings.Contains(string(data), mountID) {
			return Status{Reason: "sentinel does not contain mount id"}
		}
	}

	return Status{OK: true}
}
