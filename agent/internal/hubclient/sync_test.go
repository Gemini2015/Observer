package hubclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSyncMounts(t *testing.T) {
	var received []EnrollMount
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/agent/mounts" {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		if request.Method != http.MethodPut || request.Header.Get("Authorization") != "Bearer agent-token" {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body struct {
			Mounts []EnrollMount `json:"mounts"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		received = body.Mounts
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"mounts": []map[string]any{
				{"id": 1, "mount_id": "photos", "manifest_epoch": 0, "state": "active"},
			},
			"added":   []string{"photos"},
			"updated": []string{},
			"removed": []string{},
		})
	}))
	defer server.Close()

	client := New(server.URL, "test")
	mounts, err := client.SyncMounts(context.Background(), "agent-token", []EnrollMount{
		{
			MountID:       "photos",
			PhysicalPath:  "/media/photos",
			FSKind:        "local",
			CaseSensitive: "auto",
			Unicode:       "auto",
			Include:       []string{},
			Exclude:       []string{"**/.observer-mount"},
			RulesHash:     "rules-1",
			RepairAllowed: true,
		},
	})
	if err != nil {
		t.Fatalf("SyncMounts: %v", err)
	}
	if len(received) != 1 || received[0].MountID != "photos" || !received[0].RepairAllowed {
		t.Fatalf("unexpected request mounts: %+v", received)
	}
	if len(mounts) != 1 || mounts[0].MountID != "photos" {
		t.Fatalf("unexpected response: %+v", mounts)
	}
}
