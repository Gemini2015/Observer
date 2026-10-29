package ratelimit

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestImmediateThenDelay(t *testing.T) {
	limiter := New(1000, 5)

	start := time.Now()
	if err := limiter.WaitFor(context.Background(), 5); err != nil {
		t.Fatalf("first wait: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Errorf("first wait should be immediate, took %v", elapsed)
	}

	start = time.Now()
	if err := limiter.WaitFor(context.Background(), 10); err != nil {
		t.Fatalf("second wait: %v", err)
	}
	elapsed := time.Since(start)
	if elapsed < 3*time.Millisecond {
		t.Errorf("second wait too short: %v", elapsed)
	}
	if elapsed > time.Second {
		t.Errorf("second wait too long: %v", elapsed)
	}
}

func TestUnlimitedWhenRateZero(t *testing.T) {
	limiter := New(0, 0)
	start := time.Now()
	if err := limiter.WaitFor(context.Background(), 1<<40); err != nil {
		t.Fatalf("wait: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 50*time.Millisecond {
		t.Errorf("expected unlimited, took %v", elapsed)
	}
}

func TestContextCancel(t *testing.T) {
	limiter := New(1, 1)
	if err := limiter.WaitFor(context.Background(), 1); err != nil {
		t.Fatalf("prime wait: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	err := limiter.WaitFor(ctx, 10)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded, got %v", err)
	}
}
