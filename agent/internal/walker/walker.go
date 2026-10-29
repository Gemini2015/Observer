// Package walker 流式遍历挂载点：按规则剪枝、跳过符号链接、产出文件条目。
package walker

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"

	"observer/agent/internal/rules"
)

// Entry 是一个待处理的文件（或需要记录的跳过项）。
type Entry struct {
	Rel        string // 相对路径，"/" 分隔
	Abs        string
	Size       int64
	MtimeNs    string
	SkipReason string // "" 表示正常文件；symlink / not_regular / error
}

// Walker 遍历一个 mount。
type Walker struct {
	Root  string
	Rules *rules.Rules
}

// New 创建遍历器。
func New(root string, compiled *rules.Rules) *Walker {
	return &Walker{Root: filepath.Clean(root), Rules: compiled}
}

// Walk 遍历 root，对每个纳入规则的文件调用 emit。emit 返回错误会中止遍历。
func (w *Walker) Walk(ctx context.Context, emit func(Entry) error) error {
	if emit == nil {
		emit = func(Entry) error { return nil }
	}

	return filepath.WalkDir(w.Root, func(path string, entry fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}

		relative, relErr := filepath.Rel(w.Root, path)
		if relErr != nil {
			return relErr
		}
		relative = filepath.ToSlash(relative)
		if relative == "." {
			relative = ""
		}

		if walkErr != nil {
			if entry != nil && entry.IsDir() {
				return fs.SkipDir
			}
			if relative != "" {
				return emit(Entry{Rel: relative, Abs: path, SkipReason: "error"})
			}
			return walkErr
		}

		if relative == "" {
			return nil
		}

		if entry.IsDir() {
			if !w.Rules.ShouldDescend(relative) {
				return fs.SkipDir
			}
			return nil
		}

		if !w.Rules.Match(relative) {
			return nil
		}

		if entry.Type()&os.ModeSymlink != 0 {
			return emit(Entry{Rel: relative, Abs: path, SkipReason: "symlink"})
		}

		info, err := entry.Info()
		if err != nil {
			return emit(Entry{Rel: relative, Abs: path, SkipReason: "error"})
		}
		if !info.Mode().IsRegular() {
			return emit(Entry{Rel: relative, Abs: path, SkipReason: "not_regular"})
		}

		return emit(Entry{
			Rel:     relative,
			Abs:     path,
			Size:    info.Size(),
			MtimeNs: strconv.FormatInt(info.ModTime().UnixNano(), 10),
		})
	})
}
