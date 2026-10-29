// Package scan 执行一个巡检任务：遍历 mount、跳过判定、哈希、批量上报、结束任务。
package scan

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"observer/agent/internal/config"
	"observer/agent/internal/hashfile"
	"observer/agent/internal/hubclient"
	"observer/agent/internal/mountguard"
	"observer/agent/internal/ratelimit"
	"observer/agent/internal/spool"
	"observer/agent/internal/state"
	"observer/agent/internal/walker"
)

const (
	defaultRecheckDays  = 90
	defaultBatchSize    = 1000
	defaultBatchWindow  = 2 * time.Second
	defaultKeepalive    = 30 * time.Second
	defaultReadBuffer   = 1 << 20
	submitRetries       = 3
)

// Job 是 hub 下发的任务。
type Job struct {
	ID      int64
	MountPk int64
	MountID string
	Mode    string
}

// Options 是执行参数。
type Options struct {
	Mount             config.Mount
	Job               Job
	Cache             *state.Cache
	Client            *hubclient.Client
	AgentToken        string
	RecheckDays       int
	BatchSize         int
	BatchInterval     time.Duration
	KeepaliveInterval time.Duration
	Spool             *spool.Spool
	Now               func() time.Time
}

// Stats 汇总一轮巡检结果。
type Stats struct {
	Seen        int
	Hashed      int64
	Skipped     int
	Unreadable  int
	Unstable    int
	BytesRead   int64
	Batches     int
	Spooled     int
	DurationMs  int64
	SkipReasons map[string]int
}

// Run 执行任务。任务一定以 finish 收尾（完成/取消/掉盘）。
func Run(ctx context.Context, options Options) (Stats, error) {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	recheckDays := options.RecheckDays
	if recheckDays <= 0 {
		recheckDays = defaultRecheckDays
	}
	batchSize := options.BatchSize
	if batchSize <= 0 {
		batchSize = defaultBatchSize
	}
	batchWindow := options.BatchInterval
	if batchWindow <= 0 {
		batchWindow = defaultBatchWindow
	}
	keepaliveInterval := options.KeepaliveInterval
	if keepaliveInterval <= 0 {
		keepaliveInterval = defaultKeepalive
	}

	mount := options.Mount
	job := options.Job
	started := now()
	stats := Stats{SkipReasons: map[string]int{}}

	guard := mountguard.Check(mount.Path, mount.Sentinel, mount.ID)
	if !guard.OK {
		stats.DurationMs = now().Sub(started).Milliseconds()
		_, err := finish(ctx, options, job, "completed", stats, &hubclient.Guard{
			Status: "unavailable",
			Reason: guard.Reason,
		})
		return stats, err
	}

	scanCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	var keepaliveWG sync.WaitGroup
	if options.Client != nil && options.AgentToken != "" {
		keepaliveWG.Add(1)
		go func() {
			defer keepaliveWG.Done()
			ticker := time.NewTicker(keepaliveInterval)
			defer ticker.Stop()
			for {
				select {
				case <-scanCtx.Done():
					return
				case <-ticker.C:
					response, err := options.Client.Heartbeat(scanCtx, options.AgentToken, hubclient.HeartbeatRequest{})
					if err != nil {
						continue // 网络抖动时保持扫描，交给租约/重试
					}
					if response.Cancel {
						cancel()
						return
					}
					if response.Job == nil || response.Job.ID != job.ID {
						cancel()
						return
					}
				}
			}
		}()
	}

	fileLimiter := ratelimit.New(mount.EffectiveLimits.FilesPerSec, 10)
	byteLimiter := ratelimit.New(
		float64(mount.EffectiveLimits.BytesPerSec),
		float64(mount.EffectiveLimits.BurstBytes),
	)
	buffer := make([]byte, defaultReadBuffer)
	skipHashing := job.Mode == "incremental"

	var (
		pending     []hubclient.Entry
		lastFlush   = now()
		seq         int64
		flushError  error
	)
	flush := func(force bool) error {
		if flushError != nil {
			return flushError
		}
		if len(pending) == 0 {
			return nil
		}
		if !force && len(pending) < batchSize && now().Sub(lastFlush) < batchWindow {
			return nil
		}
		batch := pending
		pending = nil
		lastFlush = now()
		seq++
		stats.Batches++
		if err := submitBatch(scanCtx, options, job, seq, batch); err != nil {
			flushError = err
			return err
		}
		return nil
	}

	walkErr := walker.New(mount.Path, mount.Rules).Walk(scanCtx, func(entry walker.Entry) error {
		if flushError != nil {
			return flushError
		}

		if entry.SkipReason != "" {
			stats.Skipped++
			stats.SkipReasons[entry.SkipReason]++
			if entry.SkipReason == "error" {
				pending = append(pending, unreadableEntry(entry))
				return flush(false)
			}
			return nil
		}

		stats.Seen++
		if err := fileLimiter.WaitFor(scanCtx, 1); err != nil {
			return err
		}

		if skipHashing {
			if cached, found, err := options.Cache.Get(mount.ID, entry.Rel); err == nil && found {
				hashedAt := time.UnixMilli(cached.HashedAt)
				fresh := now().Sub(hashedAt) < time.Duration(recheckDays)*24*time.Hour
				if fresh && cached.Size == entry.Size && cached.MtimeNs == entry.MtimeNs {
					stats.Skipped++
					pending = append(pending, skippedEntry(entry))
					return flush(false)
				}
			}
		}

		if err := byteLimiter.WaitFor(scanCtx, float64(entry.Size)); err != nil {
			return err
		}

		sum, read, err := hashfile.SumFile(entry.Abs, buffer, nil)
		stats.BytesRead += read
		if err != nil {
			stats.Unreadable++
			pending = append(pending, unreadableEntry(entry))
			return flush(false)
		}

		after, statErr := os.Stat(entry.Abs)
		if statErr != nil ||
			after.Size() != entry.Size ||
			formatMtime(after) != entry.MtimeNs {
			stats.Unstable++
			pending = append(pending, unstableEntry(entry))
			return flush(false)
		}

		if err := options.Cache.Put(mount.ID, entry.Rel, state.FileState{
			Size:     entry.Size,
			MtimeNs:  entry.MtimeNs,
			HashedAt: now().UnixMilli(),
		}); err != nil {
			return fmt.Errorf("update cache: %w", err)
		}

		stats.Hashed++
		pending = append(pending, hubclient.Entry{
			PathKey:        entry.Rel,
			PathDisplayB64: base64.StdEncoding.EncodeToString([]byte(entry.Rel)),
			Size:           entry.Size,
			MtimeNs:        entry.MtimeNs,
			Hash:           sum,
			Status:         "ok",
		})
		return flush(false)
	})

	if walkErr == nil {
		if err := flush(true); err != nil && flushError == nil {
			flushError = err
		}
	}

	keepaliveCancel := func() {
		cancel()
		keepaliveWG.Wait()
	}
	keepaliveCancel()

	if walkErr != nil && !errors.Is(walkErr, context.Canceled) && flushError == nil {
		flushError = walkErr
	}

	stats.DurationMs = now().Sub(started).Milliseconds()
	if flushError != nil {
		// 结果没送完：不结束任务，等租约过期后重派。
		return stats, flushError
	}

	status := "completed"
	if walkErr != nil && errors.Is(walkErr, context.Canceled) {
		status = "canceled"
	}
	_, err := finish(ctx, options, job, status, stats, &hubclient.Guard{Status: "ok"})
	return stats, err
}

func submitBatch(ctx context.Context, options Options, job Job, seq int64, entries []hubclient.Entry) error {
	if options.Client == nil {
		return nil
	}
	var lastErr error
	for attempt := 0; attempt < submitRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
			}
		}
		_, err := options.Client.SubmitResults(ctx, options.AgentToken, job.ID, seq, entries)
		if err == nil {
			return nil
		}
		lastErr = err
		if !hubclient.IsRetryable(err) {
			return err
		}
	}
	if options.Spool != nil {
		if spoolErr := options.Spool.Append(spool.Batch{JobID: job.ID, Seq: seq, Entries: entries}); spoolErr == nil {
			return nil
		}
	}
	return lastErr
}

func finish(
	ctx context.Context,
	options Options,
	job Job,
	status string,
	stats Stats,
	guard *hubclient.Guard,
) (*hubclient.FinishResponse, error) {
	if options.Client == nil {
		return nil, nil
	}
	request := hubclient.FinishRequest{Status: status, Stats: statsMap(stats), Guard: guard}
	return options.Client.Finish(ctx, options.AgentToken, job.ID, request)
}

func statsMap(stats Stats) map[string]any {
	return map[string]any{
		"seen":        stats.Seen,
		"hashed":      stats.Hashed,
		"skipped":     stats.Skipped,
		"unreadable":  stats.Unreadable,
		"unstable":    stats.Unstable,
		"bytes_read":  stats.BytesRead,
		"batches":     stats.Batches,
		"spooled":     stats.Spooled,
		"duration_ms": stats.DurationMs,
		"skip_reasons": stats.SkipReasons,
	}
}

func skippedEntry(entry walker.Entry) hubclient.Entry {
	return hubclient.Entry{
		PathKey:        entry.Rel,
		PathDisplayB64: base64.StdEncoding.EncodeToString([]byte(entry.Rel)),
		Size:           entry.Size,
		MtimeNs:        entry.MtimeNs,
		Status:         "skipped",
		SkipReason:     "unchanged",
	}
}

func unstableEntry(entry walker.Entry) hubclient.Entry {
	return hubclient.Entry{
		PathKey:        entry.Rel,
		PathDisplayB64: base64.StdEncoding.EncodeToString([]byte(entry.Rel)),
		Size:           entry.Size,
		MtimeNs:        entry.MtimeNs,
		Status:         "unstable",
		SkipReason:     "changed_during_read",
	}
}

func unreadableEntry(entry walker.Entry) hubclient.Entry {
	return hubclient.Entry{
		PathKey:        entry.Rel,
		PathDisplayB64: base64.StdEncoding.EncodeToString([]byte(entry.Rel)),
		Size:           entry.Size,
		MtimeNs:        entry.MtimeNs,
		Status:         "unreadable",
		SkipReason:     "read_error",
	}
}

func formatMtime(info os.FileInfo) string {
	return fmt.Sprintf("%d", info.ModTime().UnixNano())
}
