// Package rules 实现 mount 的 include/exclude 路径规则：exclude 优先，doublestar 语义。
package rules

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
)

// Rules 是编译后的规则集合，可安全并发用于匹配。
type Rules struct {
	include         []string
	exclude         []string
	caseFold        bool
	includePrefixes []string
	hash            string
}

// Compile 校验并编译规则。caseFold 为 true 时忽略大小写。
func Compile(include, exclude []string, caseFold bool) (*Rules, error) {
	inc, err := normalize("include", include, caseFold)
	if err != nil {
		return nil, err
	}
	exc, err := normalize("exclude", exclude, caseFold)
	if err != nil {
		return nil, err
	}

	r := &Rules{include: inc, exclude: exc, caseFold: caseFold}
	for _, pattern := range inc {
		r.includePrefixes = append(r.includePrefixes, staticPrefix(pattern))
	}
	r.hash = computeHash(inc, exc, caseFold)
	return r, nil
}

func normalize(kind string, patterns []string, caseFold bool) ([]string, error) {
	out := make([]string, 0, len(patterns))
	for _, raw := range patterns {
		pattern := strings.TrimSpace(raw)
		if pattern == "" {
			return nil, fmt.Errorf("%s pattern must not be empty", kind)
		}
		pattern = strings.ReplaceAll(pattern, "\\", "/")
		pattern = strings.TrimPrefix(pattern, "./")
		if strings.HasPrefix(pattern, "/") {
			return nil, fmt.Errorf("%s pattern %q must be relative", kind, raw)
		}
		for _, segment := range strings.Split(pattern, "/") {
			if segment == ".." {
				return nil, fmt.Errorf("%s pattern %q must not contain '..'", kind, raw)
			}
		}
		if !doublestar.ValidatePattern(pattern) {
			return nil, fmt.Errorf("invalid %s pattern %q", kind, raw)
		}
		if caseFold {
			pattern = strings.ToLower(pattern)
		}
		out = append(out, pattern)
	}
	return out, nil
}

// Match 判断相对路径（"/" 分隔）是否纳入巡检。
func (r *Rules) Match(relative string) bool {
	if relative == "" {
		return false
	}
	path := strings.TrimPrefix(relative, "./")
	if r.caseFold {
		path = strings.ToLower(path)
	}

	for _, pattern := range r.exclude {
		if ok, _ := doublestar.Match(pattern, path); ok {
			return false
		}
	}
	if len(r.include) == 0 {
		return true
	}
	for _, pattern := range r.include {
		if ok, _ := doublestar.Match(pattern, path); ok {
			return true
		}
	}
	return false
}

// ShouldDescend 判断目录是否值得继续遍历（按 include 的静态前缀剪枝）。
func (r *Rules) ShouldDescend(directory string) bool {
	if directory == "" {
		return true
	}
	if len(r.includePrefixes) == 0 {
		return true
	}
	dir := strings.TrimSuffix(directory, "/")
	if r.caseFold {
		dir = strings.ToLower(dir)
	}
	for _, prefix := range r.includePrefixes {
		if prefix == "" {
			return true
		}
		if dir == prefix ||
			strings.HasPrefix(prefix, dir+"/") ||
			strings.HasPrefix(dir, prefix+"/") {
			return true
		}
	}
	return false
}

// Hash 返回规则指纹，随结果上报供 hub 判断规则是否变化。
func (r *Rules) Hash() string {
	return r.hash
}

// Include / Exclude 返回规范化后的模式，便于调试输出。
func (r *Rules) Include() []string { return append([]string(nil), r.include...) }
func (r *Rules) Exclude() []string { return append([]string(nil), r.exclude...) }

func staticPrefix(pattern string) string {
	cut := len(pattern)
	for i, ch := range pattern {
		switch ch {
		case '*', '?', '[', '{':
			cut = i
		default:
		}
		if cut != len(pattern) {
			break
		}
	}
	prefix := strings.TrimSuffix(pattern[:cut], "/")
	return prefix
}

func computeHash(include, exclude []string, caseFold bool) string {
	payload := struct {
		Include  []string `json:"include"`
		Exclude  []string `json:"exclude"`
		CaseFold bool     `json:"case_fold"`
	}{Include: include, Exclude: exclude, CaseFold: caseFold}
	encoded, _ := json.Marshal(payload)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}
