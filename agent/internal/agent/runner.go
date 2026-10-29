// Package agent 编排 agent 的运行：注册、心跳、清单同步、巡检、spool 补发。
package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"observer/agent/internal/config"
	"observer/agent/internal/hubclient"
	"observer/agent/internal/mountguard"
	"observer/agent/internal/scan"
	"observer/agent/internal/spool"
	"observer/agent/internal/state"
)

const manifestBatchSize = 10_000

// Runner 是 agent 的运行器。
type Runner struct {
	Config  *config.Config
	Client  *hubclient.Client
	Cache   *state.Cache
	Spool   *spool.Spool
	Version string
	Now     func() time.Time
	token   string
}

// New 创建运行器。
func New(cfg *config.Config, version string) (*Runner, error) {
	baseDir := filepath.Dir(cfg.Agent.TokenFile)
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		return nil, err
	}
	cache, err := state.Open(filepath.Join(baseDir, "state.db"))
	if err != nil {
		return nil, err
	}
	queue, err := spool.Open(filepath.Join(baseDir, "spool.jsonl"))
	if err != nil {
		_ = cache.Close()
		return nil, err
	}
	return &Runner{
		Config:  cfg,
		Client:  hubclient.New(cfg.Agent.Hub, version),
		Cache:   cache,
		Spool:   queue,
		Version: version,
		Now:     time.Now,
	}, nil
}

// Close 释放缓存句柄。
func (r *Runner) Close() error {
	return r.Cache.Close()
}

// EnsureToken 读取本地 token；没有则用一次性 token 注册。
func (r *Runner) EnsureToken(ctx context.Context, enrollToken string) error {
	tokenPath := r.Config.Agent.TokenFile
	if data, err := os.ReadFile(tokenPath); err == nil {
		token := strings.TrimSpace(string(data))
		if token != "" {
			r.token = token
			return nil
		}
	}
	if enrollToken == "" {
		return errors.New("agent not enrolled: set OBSERVER_ENROLL_TOKEN or pass --enroll-token")
	}

	response, err := r.Client.Enroll(ctx, enrollToken, r.enrollRequest())
	if err != nil {
		return fmt.Errorf("enroll: %w", err)
	}
	if err := os.WriteFile(tokenPath, []byte(response.Token+"\n"), 0o600); err != nil {
		return fmt.Errorf("save token: %w", err)
	}
	r.token = response.Token
	return nil
}

// RunOnce 执行一轮：补发 spool → 心跳 → 清单同步 → 执行任务（如有）。
func (r *Runner) RunOnce(ctx context.Context) (scan.Stats, error) {
	if r.token == "" {
		if err := r.EnsureToken(ctx, os.Getenv("OBSERVER_ENROLL_TOKEN")); err != nil {
			return scan.Stats{}, err
		}
	}

	r.flushSpool(ctx)

	beat, err := r.Client.Heartbeat(ctx, r.token, hubclient.HeartbeatRequest{AgentVersion: r.Version})
	if err != nil {
		return scan.Stats{}, fmt.Errorf("heartbeat: %w", err)
	}
	if err := r.syncManifests(ctx, beat); err != nil {
		return scan.Stats{}, fmt.Errorf("manifest sync: %w", err)
	}
	if beat.Job == nil {
		return scan.Stats{}, nil
	}

	mount, ok := r.findMount(beat.Job.MountID)
	if !ok {
		return scan.Stats{}, fmt.Errorf("hub dispatched unknown mount %q", beat.Job.MountID)
	}

	stats, err := scan.Run(ctx, scan.Options{
		Mount:      mount,
		Job:        scan.Job{ID: beat.Job.ID, MountPk: beat.Job.MountPk, MountID: beat.Job.MountID, Mode: beat.Job.Mode},
		Cache:      r.Cache,
		Client:     r.Client,
		AgentToken: r.token,
		Spool:      r.Spool,
		Now:        r.Now,
	})
	return stats, err
}

// Run 常驻循环。
func (r *Runner) Run(ctx context.Context, interval time.Duration) error {
	if interval <= 0 {
		interval = 15 * time.Second
	}
	for {
		if _, err := r.RunOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
			fmt.Fprintf(os.Stderr, "observer-agent: %v\n", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
}

// Doctor 自检：配置、目录、sentinel、hub、token。
func (r *Runner) Doctor(ctx context.Context) error {
	problems := make([]string, 0)

	for _, mount := range r.Config.Mounts {
		status := mountguard.Check(mount.Path, mount.Sentinel, mount.ID)
		if !status.OK {
			problems = append(problems, fmt.Sprintf("mount %s: %s", mount.ID, status.Reason))
		}
	}

	if _, err := os.Stat(r.Config.Agent.TokenFile); err != nil {
		problems = append(problems, fmt.Sprintf("token file %s: %v", r.Config.Agent.TokenFile, err))
	}

	if err := r.Client.Health(ctx); err != nil {
		problems = append(problems, fmt.Sprintf("hub %s: %v", r.Config.Agent.Hub, err))
	}

	if len(problems) > 0 {
		return fmt.Errorf("%s", strings.Join(problems, "; "))
	}
	return nil
}

func (r *Runner) findMount(mountID string) (config.Mount, bool) {
	for _, mount := range r.Config.Mounts {
		if mount.ID == mountID {
			return mount, true
		}
	}
	return config.Mount{}, false
}

func (r *Runner) enrollRequest() hubclient.EnrollRequest {
	hostname, _ := os.Hostname()
	request := hubclient.EnrollRequest{
		MachineID:    r.Config.Agent.MachineID,
		Label:        r.Config.Agent.Label,
		Hostname:     hostname,
		Platform:     runtime.GOOS,
		Arch:         runtime.GOARCH,
		AgentVersion: r.Version,
		Mounts:       make([]hubclient.EnrollMount, 0, len(r.Config.Mounts)),
	}
	for _, mount := range r.Config.Mounts {
		request.Mounts = append(request.Mounts, hubclient.EnrollMount{
			MountID:       mount.ID,
			Label:         mount.Label,
			PhysicalPath:  mount.Path,
			Sentinel:      mount.Sentinel,
			FSKind:        mount.FSKind,
			CaseSensitive: mount.CaseSensitive,
			Unicode:       mount.Unicode,
			Include:       mount.Include,
			Exclude:       mount.Exclude,
			RulesHash:     mount.RulesHash,
			Limits: map[string]any{
				"bytes_per_sec": int64(mount.EffectiveLimits.BytesPerSec),
				"files_per_sec": mount.EffectiveLimits.FilesPerSec,
				"burst_bytes":   int64(mount.EffectiveLimits.BurstBytes),
				"on_window_end": mount.EffectiveLimits.OnWindowEnd,
			},
			Schedule: map[string]any{
				"budget_minutes_per_day": mount.Schedule.BudgetMinutesPerDay,
				"window":                 mount.Schedule.Window,
			},
		})
	}
	return request
}

func (r *Runner) flushSpool(ctx context.Context) {
	batches, err := r.Spool.ReadAll()
	if err != nil || len(batches) == 0 {
		return
	}
	remaining := make([]spool.Batch, 0, len(batches))
	for _, batch := range batches {
		_, submitErr := r.Client.SubmitResults(ctx, r.token, batch.JobID, batch.Seq, batch.Entries)
		if submitErr == nil {
			continue
		}
		if isPermanent(submitErr) {
			continue // 任务已过期/取消，丢弃批次
		}
		remaining = append(remaining, batch)
	}
	if err := r.Spool.Replace(remaining); err != nil {
		fmt.Fprintf(os.Stderr, "observer-agent: rewrite spool: %v\n", err)
	}
}

func (r *Runner) syncManifests(ctx context.Context, beat *hubclient.HeartbeatResponse) error {
	for _, ref := range beat.Mounts {
		mount, ok := r.findMount(ref.MountID)
		if !ok {
			continue // hub 上有本机配置未声明的 mount：M1 忽略
		}

		meta, found, err := r.Cache.GetMeta(mount.ID)
		if err != nil {
			return err
		}
		dbChanged := !found || meta.DBInstance != beat.DBInstance
		epochChanged := !found || meta.Epoch != ref.ManifestEpoch
		fullResyncDue := !found || (r.Config.Agent.CacheFullResyncDays > 0 &&
			r.Now().UnixMilli()-meta.FullSyncAt > int64(r.Config.Agent.CacheFullResyncDays)*24*60*60*1000)

		if !dbChanged && !epochChanged && !fullResyncDue {
			continue
		}
		if err := r.pullManifest(ctx, mount.ID, ref.ID); err != nil {
			return err
		}
		if err := r.Cache.PutMeta(mount.ID, state.Meta{
			DBInstance: beat.DBInstance,
			Epoch:      ref.ManifestEpoch,
			FullSyncAt: r.Now().UnixMilli(),
		}); err != nil {
			return err
		}
	}
	return nil
}

type manifestLine struct {
	PathKey string `json:"k"`
	Size    int64  `json:"s"`
	MtimeNs string `json:"m"`
	HashedAt int64 `json:"h"`
}

func (r *Runner) pullManifest(ctx context.Context, mountID string, mountPk int64) error {
	body, err := r.Client.Manifest(ctx, r.token, mountPk)
	if err != nil {
		return err
	}
	defer body.Close()

	if err := r.Cache.ClearMount(mountID); err != nil {
		return err
	}

	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64*1024), 4<<20)
	batch := make(map[string]state.FileState, manifestBatchSize)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := r.Cache.PutBatch(mountID, batch); err != nil {
			return err
		}
		batch = make(map[string]state.FileState, manifestBatchSize)
		return nil
	}

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var item manifestLine
		if err := json.Unmarshal(line, &item); err != nil {
			continue
		}
		batch[item.PathKey] = state.FileState{
			Size:     item.Size,
			MtimeNs:  item.MtimeNs,
			HashedAt: item.HashedAt,
		}
		if len(batch) >= manifestBatchSize {
			if err := flush(); err != nil {
				return err
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return flush()
}

func isPermanent(err error) bool {
	var problem *hubclient.Problem
	if errors.As(err, &problem) {
		return problem.Status >= 400 && problem.Status < 500 && !problem.Retryable
	}
	return false
}
