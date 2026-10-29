package hubclient

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientFlow(t *testing.T) {
	var receivedEntries int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/v1/enroll":
			if request.Header.Get("x-observer-enroll-token") != "enroll-token" {
				writer.WriteHeader(http.StatusUnauthorized)
				_, _ = writer.Write([]byte(`{"title":"unauthorized","status":401}`))
				return
			}
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"agent_id": 1, "token": "agent-token", "machine_id": "m",
				"protocol": 1, "mounts": []map[string]any{{"id": 1, "mount_id": "drill", "manifest_epoch": 0}},
			})
		case "/api/v1/agent/heartbeat":
			if request.Header.Get("Authorization") != "Bearer agent-token" {
				writer.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"server_time": 1, "db_instance": "db-1", "cancel": false,
				"job":     map[string]any{"id": 7, "mount_pk": 1, "mount_id": "drill", "mode": "baseline", "lease_until": 9},
				"mounts":  []map[string]any{{"id": 1, "mount_id": "drill", "manifest_epoch": 0}},
			})
		case "/api/v1/jobs/7/results":
			var batch struct {
				Seq     int64   `json:"seq"`
				Entries []Entry `json:"entries"`
			}
			_ = json.NewDecoder(request.Body).Decode(&batch)
			receivedEntries = len(batch.Entries)
			_ = json.NewEncoder(writer).Encode(map[string]any{"accepted": len(batch.Entries), "duplicate": false, "manifest_epoch": 1})
		case "/api/v1/jobs/7/finish":
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"ok": true, "job_status": "completed",
				"coverage": map[string]any{"total": 2, "hashed": 2, "ratio": 1},
			})
		case "/api/v1/mounts/1/manifest":
			writer.Header().Set("Content-Type", "application/x-ndjson")
			writer.Header().Set("Content-Encoding", "gzip")
			zipper := gzip.NewWriter(writer)
			_, _ = zipper.Write([]byte(`{"k":"a.txt","s":1,"m":"1","h":2}` + "\n"))
			_ = zipper.Close()
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := New(server.URL, "test")
	ctx := context.Background()

	enrolled, err := client.Enroll(ctx, "enroll-token", EnrollRequest{MachineID: "m"})
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	if enrolled.Token != "agent-token" {
		t.Fatalf("token = %q", enrolled.Token)
	}

	beat, err := client.Heartbeat(ctx, "agent-token", HeartbeatRequest{})
	if err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}
	if beat.Job == nil || beat.Job.ID != 7 || beat.DBInstance != "db-1" {
		t.Fatalf("unexpected heartbeat: %+v", beat)
	}

	entries := []Entry{{PathKey: "a.txt", Status: "ok"}}
	if _, err := client.SubmitResults(ctx, "agent-token", 7, 1, entries); err != nil {
		t.Fatalf("SubmitResults: %v", err)
	}
	if receivedEntries != 1 {
		t.Fatalf("received entries = %d", receivedEntries)
	}

	finished, err := client.Finish(ctx, "agent-token", 7, FinishRequest{Status: "completed"})
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if !finished.OK || finished.Coverage.Ratio != 1 {
		t.Fatalf("unexpected finish: %+v", finished)
	}

	body, err := client.Manifest(ctx, "agent-token", 1)
	if err != nil {
		t.Fatalf("Manifest: %v", err)
	}
	defer body.Close()
	buffer := make([]byte, 64)
	read, _ := body.Read(buffer)
	if read == 0 {
		t.Fatal("expected manifest body")
	}
}

func TestProblemErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/problem+json")
		writer.WriteHeader(http.StatusConflict)
		_, _ = writer.Write([]byte(`{"title":"job not running","status":409,"retryable":false}`))
	}))
	defer server.Close()

	client := New(server.URL, "test")
	_, err := client.Finish(context.Background(), "token", 1, FinishRequest{Status: "completed"})
	if err == nil {
		t.Fatal("expected error")
	}
	var problem *Problem
	if !asProblem(err, &problem) {
		t.Fatalf("expected Problem, got %T", err)
	}
	if problem.Status != 409 || IsRetryable(err) {
		t.Fatalf("problem = %+v, retryable=%v", problem, IsRetryable(err))
	}
}
