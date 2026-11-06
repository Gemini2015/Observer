package main

import (
	"strings"
	"testing"

	agentcore "observer/agent/internal/agent"
	"observer/agent/internal/scan"
)

func TestRecordRunIgnoresIdlePoll(t *testing.T) {
	c := &controller{wake: make(chan struct{}, 1)}
	c.status.LastStats = &RunSummary{Seen: 5}
	c.status.LastRunAt = 123
	c.status.LastError = "old"
	c.status.LastErrorAt = 456

	c.recordRun(false, scan.Stats{}, nil, 999)

	if c.status.LastStats == nil || c.status.LastStats.Seen != 5 {
		t.Fatalf("idle poll must not clear last stats, got %+v", c.status.LastStats)
	}
	if c.status.LastRunAt != 123 {
		t.Fatalf("idle poll must not refresh last run time, got %d", c.status.LastRunAt)
	}
	if c.status.LastError != "old" || c.status.LastErrorAt != 456 {
		t.Fatalf("idle poll must not clear last error, got %q @%d", c.status.LastError, c.status.LastErrorAt)
	}
}

func TestRecordRunSuccessUpdatesStatsAndClearsError(t *testing.T) {
	c := &controller{wake: make(chan struct{}, 1)}
	c.status.LastError = "boom"
	c.status.LastErrorAt = 100

	c.recordRun(true, scan.Stats{Seen: 3, Hashed: 2, Skipped: 1, DurationMs: 42}, nil, 200)

	if c.status.LastStats == nil || c.status.LastStats.Seen != 3 || c.status.LastStats.Hashed != 2 {
		t.Fatalf("unexpected stats: %+v", c.status.LastStats)
	}
	if c.status.LastRunAt != 200 || c.status.LastOkAt != 200 {
		t.Fatalf("run/ok timestamps not updated: run=%d ok=%d", c.status.LastRunAt, c.status.LastOkAt)
	}
	if c.status.LastError != "" || c.status.LastErrorAt != 0 {
		t.Fatalf("error not cleared: %q @%d", c.status.LastError, c.status.LastErrorAt)
	}
	if !c.status.Connected {
		t.Fatal("successful run should mark connected")
	}
}

func TestRecordRunFailureKeepsStatsAndSetsTime(t *testing.T) {
	c := &controller{wake: make(chan struct{}, 1)}
	c.status.LastStats = &RunSummary{Seen: 7}
	c.status.LastRunAt = 10

	c.recordRun(true, scan.Stats{}, errString("scan failed"), 300)

	if c.status.LastStats == nil || c.status.LastStats.Seen != 7 {
		t.Fatalf("failed run must keep previous stats, got %+v", c.status.LastStats)
	}
	if c.status.LastError != "scan failed" || c.status.LastErrorAt != 300 {
		t.Fatalf("error not recorded: %q @%d", c.status.LastError, c.status.LastErrorAt)
	}
	if c.status.LastRunAt != 300 {
		t.Fatalf("failed run should still record last attempt, got %d", c.status.LastRunAt)
	}
}

func TestRecordPollUpdatesConnectivity(t *testing.T) {
	c := &controller{wake: make(chan struct{}, 1)}

	c.recordPoll(nil, 100)
	if !c.status.Connected || c.status.LastOkAt != 100 {
		t.Fatalf("successful poll should mark connected: %+v", c.status)
	}

	c.recordPoll(errString("dial hub: refused"), 200)
	if c.status.Connected {
		t.Fatal("failed poll should mark disconnected")
	}
	if c.status.LastError != "dial hub: refused" || c.status.LastErrorAt != 200 {
		t.Fatalf("poll error not recorded: %q @%d", c.status.LastError, c.status.LastErrorAt)
	}
}

func TestScanNowRequiresRunner(t *testing.T) {
	c := &controller{wake: make(chan struct{}, 1)}
	err := c.scanNow()
	if err == nil || !strings.Contains(err.Error(), "尚未连接") {
		t.Fatalf("expected not-ready error, got %v", err)
	}
}

func TestScanNowRejectsPaused(t *testing.T) {
	c := &controller{wake: make(chan struct{}, 1), runner: &agentcore.Runner{}, paused: true}
	err := c.scanNow()
	if err == nil || !strings.Contains(err.Error(), "已暂停") {
		t.Fatalf("expected paused error, got %v", err)
	}
}

func TestScanNowWakesLoop(t *testing.T) {
	c := &controller{wake: make(chan struct{}, 1), runner: &agentcore.Runner{}}
	if err := c.scanNow(); err != nil {
		t.Fatalf("unexpected scanNow error: %v", err)
	}
	select {
	case <-c.wake:
	default:
		t.Fatal("scanNow should enqueue a wake signal")
	}
}

func TestSetPausedUpdatesStatus(t *testing.T) {
	c := &controller{wake: make(chan struct{}, 1)}
	c.setPaused(true)
	if !c.status.Paused || !c.isPaused() {
		t.Fatalf("paused state not applied: %+v", c.status)
	}
	c.setPaused(false)
	if c.status.Paused || c.isPaused() {
		t.Fatalf("paused state not cleared: %+v", c.status)
	}
}

type errString string

func (e errString) Error() string { return string(e) }
