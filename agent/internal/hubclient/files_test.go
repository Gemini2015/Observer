package hubclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFiles(t *testing.T) {
	var receivedQuery string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer agent-token" {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch request.URL.Path {
		case "/api/v1/agent/files":
			receivedQuery = request.URL.RawQuery
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"items": []map[string]any{
					{
						"id": 7, "machine_id": "test-pc", "mount_pk": 2, "mount_id": "data",
						"path_key": "a/b.txt", "path_display_b64": "YS9iLnR4dA==",
						"state": "active", "size": 12, "mtime_ns": "1", "open_issue_count": 1,
					},
				},
				"total": 1, "limit": 50, "offset": 0,
				"summary": map[string]any{
					"total": 1, "active": 1, "missing": 0, "out_of_scope": 0,
					"hashed": 1, "unhashed": 0, "open_issue_paths": 1,
				},
			})
		case "/api/v1/agent/files/7":
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"file": map[string]any{
					"id": 7, "machine_id": "test-pc", "mount_pk": 2, "mount_id": "data",
					"path_key": "a/b.txt", "path_display_b64": "YS9iLnR4dA==",
					"state": "active", "size": 12, "mtime_ns": "1", "open_issue_count": 1,
				},
				"machine": map[string]any{"machine_id": "test-pc", "status": "online"},
				"mount":   map[string]any{"id": 2, "mount_id": "data", "physical_path": "D:\\Data", "state": "active"},
				"issues": []map[string]any{
					{"id": 3, "type": "missing", "status": "open", "confidence": "medium", "occurrences": 1},
				},
				"observations": []map[string]any{
					{"hash": "deadbeef", "kind": "baseline", "observed_at": 123},
				},
			})
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := New(server.URL, "test")
	result, err := client.ListFiles(context.Background(), "agent-token", FileQuery{
		Q: "a/b", MountID: "data", State: "active", Issue: "open", Hash: "hashed",
		Sort: "path", Order: "asc", Limit: 50, Offset: 0,
	})
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	if result.Total != 1 || len(result.Items) != 1 || result.Items[0].PathKey != "a/b.txt" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if result.Summary.OpenIssuePath != 1 {
		t.Fatalf("unexpected summary: %+v", result.Summary)
	}
	for _, expected := range []string{"q=a%2Fb", "mount_id=data", "state=active", "issue=open", "hash=hashed", "limit=50"} {
		if !contains(receivedQuery, expected) {
			t.Fatalf("query %q missing %q", receivedQuery, expected)
		}
	}

	detail, err := client.FileDetail(context.Background(), "agent-token", 7)
	if err != nil {
		t.Fatalf("FileDetail: %v", err)
	}
	if detail.File.ID != 7 || detail.Mount.PhysicalPath != "D:\\Data" || len(detail.Issues) != 1 {
		t.Fatalf("unexpected detail: %+v", detail)
	}
	if len(detail.Observations) != 1 || detail.Observations[0].Kind != "baseline" {
		t.Fatalf("unexpected observations: %+v", detail.Observations)
	}
}

func contains(value, needle string) bool {
	for i := 0; i+len(needle) <= len(value); i++ {
		if value[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
