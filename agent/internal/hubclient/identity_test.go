package hubclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/agent/identity" {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		if request.Header.Get("Authorization") != "Bearer agent-token" {
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"title": "unauthorized", "status": 401,
			})
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"agent_id":   7,
			"machine_id": "test-pc",
			"label":      "Test PC",
			"hostname":   "TEST-PC",
			"platform":   "windows",
			"arch":       "amd64",
			"mounts": []map[string]any{
				{
					"mount_id":       "data",
					"label":          "Data",
					"physical_path":  "D:\\Data",
					"sentinel":       ".observer-mount",
					"fs_kind":        "local",
					"case_sensitive": "auto",
					"unicode":        "auto",
					"include":        []string{},
					"exclude":        []string{"**/.observer-mount"},
					"rules_hash":     "rules-1",
					"limits":         map[string]any{"bytes_per_sec": 1024},
					"schedule":       map[string]any{},
					"repair_allowed": true,
					"state":          "active",
				},
			},
		})
	}))
	defer server.Close()

	client := New(server.URL, "test")
	identity, err := client.Identity(context.Background(), "agent-token")
	if err != nil {
		t.Fatalf("Identity: %v", err)
	}
	if identity.MachineID != "test-pc" || identity.AgentID != 7 || len(identity.Mounts) != 1 {
		t.Fatalf("unexpected identity: %+v", identity)
	}
	mount := identity.Mounts[0]
	if mount.MountID != "data" || mount.PhysicalPath != "D:\\Data" || !mount.RepairAllowed {
		t.Fatalf("unexpected mount: %+v", mount)
	}
	if len(mount.Exclude) != 1 || mount.Exclude[0] != "**/.observer-mount" {
		t.Fatalf("unexpected excludes: %+v", mount.Exclude)
	}

	if _, err := client.Identity(context.Background(), "bad-token"); !IsUnauthorized(err) {
		t.Fatalf("expected unauthorized, got %v", err)
	}
}
