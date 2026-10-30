package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"observer/agent/internal/config"
	"observer/agent/internal/hubclient"
)

func testRunner(t *testing.T, serverURL, token, stateDir string) *Runner {
	t.Helper()
	raw := fmt.Sprintf(`agent:
  machine_id: test-pc
  hub: %s
  token: %q
  state_dir: %s
mounts:
  - id: data
    path: %s
`, serverURL, token, filepath.ToSlash(stateDir), filepath.ToSlash(t.TempDir()))
	cfg, err := config.Parse([]byte(raw))
	if err != nil {
		t.Fatalf("parse config: %v", err)
	}
	return &Runner{
		Config: cfg,
		Client: hubclient.New(serverURL, "test"),
	}
}

func identityServer(t *testing.T, identities map[string]string) (*httptest.Server, *int) {
	t.Helper()
	enrollCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v1/agent/identity":
			token := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
			machineID, ok := identities[token]
			if !ok {
				writer.Header().Set("Content-Type", "application/json")
				writer.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(writer).Encode(map[string]any{
					"title": "unauthorized", "status": 401, "detail": "invalid token",
				})
				return
			}
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"agent_id": 1, "machine_id": machineID, "label": "Test PC",
				"mounts": []map[string]any{
					{"mount_id": "data", "physical_path": "D:\\Data", "state": "active"},
				},
			})
		case "/api/v1/enroll":
			enrollCalls++
			if request.Header.Get("x-observer-enroll-token") != "enroll-token" {
				writer.Header().Set("Content-Type", "application/json")
				writer.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(writer).Encode(map[string]any{
					"title": "unauthorized", "status": 401, "detail": "invalid enroll token",
				})
				return
			}
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"agent_id": 2, "token": "agent-from-enroll", "machine_id": "test-pc",
				"protocol": 1, "mounts": []map[string]any{},
			})
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return server, &enrollCalls
}

func TestEnsureTokenInlineAgentToken(t *testing.T) {
	stateDir := t.TempDir()
	server, _ := identityServer(t, map[string]string{"agent-valid": "test-pc"})
	runner := testRunner(t, server.URL, "agent-valid", stateDir)

	if err := runner.EnsureToken(context.Background(), ""); err != nil {
		t.Fatalf("EnsureToken: %v", err)
	}
	if runner.token != "agent-valid" {
		t.Fatalf("token = %q", runner.token)
	}
	cached, err := os.ReadFile(filepath.Join(stateDir, "agent.token"))
	if err != nil || strings.TrimSpace(string(cached)) != "agent-valid" {
		t.Fatalf("cached token = %q err=%v", cached, err)
	}
}

func TestEnsureTokenStaleCacheUsesInlineAgentToken(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, "agent.token"), []byte("agent-revoked\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	server, _ := identityServer(t, map[string]string{"agent-new": "test-pc"})
	runner := testRunner(t, server.URL, "agent-new", stateDir)

	if err := runner.EnsureToken(context.Background(), ""); err != nil {
		t.Fatalf("EnsureToken: %v", err)
	}
	if runner.token != "agent-new" {
		t.Fatalf("token = %q", runner.token)
	}
	cached, _ := os.ReadFile(filepath.Join(stateDir, "agent.token"))
	if strings.TrimSpace(string(cached)) != "agent-new" {
		t.Fatalf("cache not refreshed: %q", cached)
	}
}

func TestEnsureTokenInlineEnrollToken(t *testing.T) {
	stateDir := t.TempDir()
	server, enrollCalls := identityServer(t, nil)
	runner := testRunner(t, server.URL, "enroll-token", stateDir)

	if err := runner.EnsureToken(context.Background(), ""); err != nil {
		t.Fatalf("EnsureToken: %v", err)
	}
	if runner.token != "agent-from-enroll" {
		t.Fatalf("token = %q", runner.token)
	}
	if *enrollCalls != 1 {
		t.Fatalf("enroll calls = %d", *enrollCalls)
	}
	cached, _ := os.ReadFile(filepath.Join(stateDir, "agent.token"))
	if strings.TrimSpace(string(cached)) != "agent-from-enroll" {
		t.Fatalf("cache = %q", cached)
	}
}

func TestEnsureTokenMachineMismatch(t *testing.T) {
	stateDir := t.TempDir()
	server, _ := identityServer(t, map[string]string{"agent-other": "other-pc"})
	runner := testRunner(t, server.URL, "agent-other", stateDir)

	err := runner.EnsureToken(context.Background(), "")
	if err == nil || !strings.Contains(err.Error(), "belongs to machine") {
		t.Fatalf("error = %v", err)
	}
}

func TestEnsureTokenValidCacheSkipsEnroll(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, "agent.token"), []byte("agent-valid\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	server, enrollCalls := identityServer(t, map[string]string{"agent-valid": "test-pc"})
	runner := testRunner(t, server.URL, "", stateDir)

	if err := runner.EnsureToken(context.Background(), ""); err != nil {
		t.Fatalf("EnsureToken: %v", err)
	}
	if runner.token != "agent-valid" || *enrollCalls != 0 {
		t.Fatalf("token = %q enroll calls=%d", runner.token, *enrollCalls)
	}
}

func TestEnsureTokenOfflineUsesCache(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, "agent.token"), []byte("agent-cached\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	runner := testRunner(t, server.URL, "", stateDir)

	if err := runner.EnsureToken(context.Background(), ""); err != nil {
		t.Fatalf("EnsureToken: %v", err)
	}
	if runner.token != "agent-cached" {
		t.Fatalf("token = %q", runner.token)
	}
}
