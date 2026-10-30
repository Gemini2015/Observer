package scan

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"observer/agent/internal/config"
	"observer/agent/internal/hubclient"
	"observer/agent/internal/rules"
	"observer/agent/internal/state"
)

type fakeHub struct {
	mu       sync.Mutex
	batches  [][]hubclient.Entry
	finishes []hubclient.FinishRequest
	server   *httptest.Server
}

func newFakeHub(t *testing.T) *fakeHub {
	t.Helper()
	hub := &fakeHub{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/jobs/", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodPost && len(request.URL.Path) > len("/api/v1/jobs/") && filepath.Base(request.URL.Path) == "results":
			var batch struct {
				Seq     int64             `json:"seq"`
				Entries []hubclient.Entry `json:"entries"`
			}
			_ = json.NewDecoder(request.Body).Decode(&batch)
			hub.mu.Lock()
			hub.batches = append(hub.batches, batch.Entries)
			hub.mu.Unlock()
			_ = json.NewEncoder(writer).Encode(map[string]any{"accepted": len(batch.Entries), "duplicate": false, "manifest_epoch": 1})
		case request.Method == http.MethodPost && filepath.Base(request.URL.Path) == "finish":
			var finish hubclient.FinishRequest
			_ = json.NewDecoder(request.Body).Decode(&finish)
			hub.mu.Lock()
			hub.finishes = append(hub.finishes, finish)
			hub.mu.Unlock()
			_ = json.NewEncoder(writer).Encode(map[string]any{"ok": true, "job_status": "completed", "coverage": map[string]any{"total": 1, "hashed": 1, "ratio": 1}})
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	})
	mux.HandleFunc("/api/v1/agent/heartbeat", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{"server_time": 1, "db_instance": "db", "job": nil, "cancel": false, "mounts": []any{}})
	})
	hub.server = httptest.NewServer(mux)
	t.Cleanup(hub.server.Close)
	return hub
}

func (h *fakeHub) entries() []hubclient.Entry {
	h.mu.Lock()
	defer h.mu.Unlock()
	var all []hubclient.Entry
	for _, batch := range h.batches {
		all = append(all, batch...)
	}
	return all
}

func testMount(root string) config.Mount {
	compiled, err := rules.Compile(nil, []string{"**/.observer-mount"}, false)
	if err != nil {
		panic(err)
	}
	return config.Mount{
		ID:            "drill",
		Path:          root,
		FSKind:        "local",
		CaseSensitive: "auto",
		Rules:         compiled,
		RulesHash:     compiled.Hash(),
		EffectiveLimits: config.Limits{
			BytesPerSec: 1 << 30,
			FilesPerSec: 1e9,
			BurstBytes:  1 << 30,
		},
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRunBaselineIncrementalAndFull(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "a.txt"), "hello")
	writeFile(t, filepath.Join(root, "sub", "b.txt"), "world")

	cache, err := state.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	defer cache.Close()

	hub := newFakeHub(t)
	options := Options{
		Mount:             testMount(root),
		Job:               Job{ID: 1, MountID: "drill", Mode: "baseline"},
		Cache:             cache,
		Client:            hubclient.New(hub.server.URL, "test"),
		AgentToken:        "token",
		BatchSize:         100,
		BatchInterval:     time.Hour,
		KeepaliveInterval: time.Hour,
	}

	stats, err := Run(context.Background(), options)
	if err != nil {
		t.Fatalf("baseline Run: %v", err)
	}
	if stats.Hashed != 2 || stats.Skipped != 0 {
		t.Fatalf("baseline stats = %+v", stats)
	}
	if got := len(hub.entries()); got != 2 {
		t.Fatalf("baseline entries = %d", got)
	}

	options.Job = Job{ID: 2, MountID: "drill", Mode: "incremental"}
	stats, err = Run(context.Background(), options)
	if err != nil {
		t.Fatalf("incremental Run: %v", err)
	}
	if stats.Hashed != 0 || stats.Skipped != 2 {
		t.Fatalf("incremental stats = %+v", stats)
	}

	writeFile(t, filepath.Join(root, "a.txt"), "HELLO")
	options.Job = Job{ID: 3, MountID: "drill", Mode: "incremental"}
	stats, err = Run(context.Background(), options)
	if err != nil {
		t.Fatalf("changed Run: %v", err)
	}
	if stats.Hashed != 1 || stats.Skipped != 1 {
		t.Fatalf("changed stats = %+v", stats)
	}

	options.Job = Job{ID: 4, MountID: "drill", Mode: "full"}
	stats, err = Run(context.Background(), options)
	if err != nil {
		t.Fatalf("full Run: %v", err)
	}
	if stats.Hashed != 2 {
		t.Fatalf("full stats = %+v", stats)
	}
}

func TestProgressCallback(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "a.txt"), "hello")
	writeFile(t, filepath.Join(root, "b.txt"), "world")

	cache, err := state.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	defer cache.Close()

	hub := newFakeHub(t)
	var (
		mu      sync.Mutex
		samples []Progress
	)
	options := Options{
		Mount:             testMount(root),
		Job:               Job{ID: 10, MountID: "drill", Mode: "baseline"},
		Cache:             cache,
		Client:            hubclient.New(hub.server.URL, "test"),
		AgentToken:        "token",
		BatchSize:         100,
		BatchInterval:     time.Hour,
		KeepaliveInterval: time.Hour,
		Progress: func(progress Progress) {
			mu.Lock()
			samples = append(samples, progress)
			mu.Unlock()
		},
	}

	stats, err := Run(context.Background(), options)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(samples) == 0 {
		t.Fatal("expected progress callbacks")
	}
	last := samples[len(samples)-1]
	if last.Seen != stats.Seen || last.Hashed != stats.Hashed || last.BytesRead != stats.BytesRead {
		t.Fatalf("progress = %+v, stats = %+v", last, stats)
	}
	if last.Seen != 2 || last.Hashed != 2 {
		t.Fatalf("unexpected progress totals: %+v", last)
	}
}
