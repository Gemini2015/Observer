package rules

import "testing"

func mustCompile(t *testing.T, include, exclude []string, caseFold bool) *Rules {
	t.Helper()
	compiled, err := Compile(include, exclude, caseFold)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	return compiled
}

func TestMatchPrecedence(t *testing.T) {
	compiled := mustCompile(t, []string{"**/*.txt"}, []string{"secret/**"}, false)

	cases := map[string]bool{
		"a.txt":         true,
		"sub/b.txt":     true,
		"a.bin":         false,
		"secret/a.txt":  false,
		"secret/sub/c":  false,
		"":              false,
	}
	for path, want := range cases {
		if got := compiled.Match(path); got != want {
			t.Errorf("Match(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestEmptyIncludeMatchesEverything(t *testing.T) {
	compiled := mustCompile(t, nil, []string{"**/*.tmp"}, false)
	if !compiled.Match("a/b.jpg") {
		t.Error("expected file to match with empty include")
	}
	if compiled.Match("a/b.tmp") {
		t.Error("exclude should win over empty include")
	}
}

func TestCaseFold(t *testing.T) {
	compiled := mustCompile(t, []string{"**/*.JPG"}, nil, true)
	if !compiled.Match("photos/a.jpg") {
		t.Error("expected case-folded match")
	}
	sensitive := mustCompile(t, []string{"**/*.JPG"}, nil, false)
	if sensitive.Match("photos/a.jpg") {
		t.Error("expected case-sensitive mismatch")
	}
}

func TestShouldDescend(t *testing.T) {
	compiled := mustCompile(t, []string{"photos/**/*.jpg"}, nil, false)
	if !compiled.ShouldDescend("") || !compiled.ShouldDescend("photos") || !compiled.ShouldDescend("photos/2024") {
		t.Error("expected photos subtree to be traversed")
	}
	if compiled.ShouldDescend("music") {
		t.Error("expected unrelated dir to be pruned")
	}
}

func TestInvalidPatterns(t *testing.T) {
	for _, pattern := range []string{"", "/absolute/**", "../escape", "["} {
		if _, err := Compile([]string{pattern}, nil, false); err == nil {
			t.Errorf("expected error for pattern %q", pattern)
		}
	}
}

func TestHashIsStableAndSensitive(t *testing.T) {
	a := mustCompile(t, []string{"**/*.txt"}, nil, false)
	b := mustCompile(t, []string{"**/*.txt"}, nil, false)
	if a.Hash() != b.Hash() {
		t.Error("expected identical rules to share a hash")
	}
	c := mustCompile(t, []string{"**/*.txt"}, []string{"**/*.tmp"}, false)
	if a.Hash() == c.Hash() {
		t.Error("expected different rules to produce a different hash")
	}
}
