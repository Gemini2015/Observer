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
	"sync"
	"time"

	"observer/agent/internal/config"
	"observer/agent/internal/hubclient"
	"observer/agent/internal/mountguard"
	"observer/agent/internal/repair"
	"observer/agent/internal/scan"
	"observer/agent/internal/spool"
	"observer/agent/internal/state"
)

const manifestBatchSize = 10_000

// Runner 是 agent 的运行器。
type Runner struct {
	Config      *config.Config
	Client      *hubclient.Client
	Cache       *state.Cache
	Spool       *spool.Spool
	Version     string
	Now         func() time.Time
	token       string
	tokenMu     sync.Mutex
	tokenInitMu sync.Mutex

	mountsSynced bool

	progressMu sync.Mutex
	current    *CurrentJob
}

// CurrentJob 是正在执行的巡检任务与实时进度。
type CurrentJob struct {
	JobID     int64         `json:"job_id"`
	MountID   string        `json:"mount_id"`
	Mode      string        `json:"mode"`
	StartedAt int64         `json:"started_at"`
	Progress  scan.Progress `json:"progress"`
}

func (r *Runner) setCurrent(job CurrentJob) {
	r.progressMu.Lock()
	r.current = &job
	r.progressMu.Unlock()
}

func (r *Runner) clearCurrent() {
	r.progressMu.Lock()
	r.current = nil
	r.progressMu.Unlock()
}

func (r *Runner) updateProgress(progress scan.Progress) {
	r.progressMu.Lock()
	if r.current != nil {
		r.current.Progress = progress
	}
	r.progressMu.Unlock()
}

// CurrentJob 返回当前正在执行的任务快照；空闲时为 nil。
func (r *Runner) CurrentJob() *CurrentJob {
	r.progressMu.Lock()
	defer r.progressMu.Unlock()
	if r.current == nil {
		return nil
	}
	snapshot := *r.current
	return &snapshot
}

func (r *Runner) setToken(token string) {
	r.tokenMu.Lock()
	r.token = token
	r.tokenMu.Unlock()
}

func (r *Runner) agentToken() string {
	r.tokenMu.Lock()
	defer r.tokenMu.Unlock()
	return r.token
}

func (r *Runner) ensureFileToken(ctx context.Context) error {
	if r.agentToken() != "" {
		return nil
	}
	r.tokenInitMu.Lock()
	defer r.tokenInitMu.Unlock()
	if r.agentToken() != "" {
		return nil
	}
	return r.EnsureToken(ctx, os.Getenv("OBSERVER_ENROLL_TOKEN"))
}

// ListFiles 拉取本 agent 所属 machine 的文件列表（供桌面端文件页使用）。
func (r *Runner) ListFiles(ctx context.Context, query hubclient.FileQuery) (*hubclient.FileListResponse, error) {
	if err := r.ensureFileToken(ctx); err != nil {
		return nil, err
	}
	return r.Client.ListFiles(ctx, r.agentToken(), query)
}

// FileDetail 拉取本 agent 所属 machine 的单个文件详情。
func (r *Runner) FileDetail(ctx context.Context, pathID int64) (*hubclient.FileDetailResponse, error) {
	if err := r.ensureFileToken(ctx); err != nil {
		return nil, err
	}
	return r.Client.FileDetail(ctx, r.agentToken(), pathID)
}

// RecentJobs 拉取本 agent 所属机器的历史任务（供桌面端展示）。
func (r *Runner) RecentJobs(ctx context.Context, limit int) ([]hubclient.JobSummary, error) {
	if r.agentToken() == "" {
		if err := r.EnsureToken(ctx, os.Getenv("OBSERVER_ENROLL_TOKEN")); err != nil {
			return nil, err
		}
	}
	return r.Client.ListJobs(ctx, r.agentToken(), limit)
}

// New 创建运行器。
func New(cfg *config.Config, version string) (*Runner, error) {
	baseDir := cfg.Agent.StateDir
	if baseDir == "" {
		baseDir = filepath.Dir(cfg.Agent.TokenFile)
	}
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

// EnsureToken 解析长期 agent token：
//  1. state_dir/agent.token（已注册缓存）：先校验；401 视为失效，网络错误则离线乐观使用；
//  2. 内联 agent.token：先按长期 agent token 校验，401 时再按一次性注册 token 尝试 enroll；
//  3. token_file（旧方式）：同样先校验再 enroll；
//  4. OBSERVER_ENROLL_TOKEN / --enroll-token 首次注册并写入缓存。
func (r *Runner) EnsureToken(ctx context.Context, enrollToken string) error {
	cachedPath := filepath.Join(r.Config.Agent.StateDir, "agent.token")
	if data, err := os.ReadFile(cachedPath); err == nil {
		if token := strings.TrimSpace(string(data)); token != "" {
			identity, identityErr := r.Client.Identity(ctx, token)
			switch {
			case identityErr == nil:
				if err := r.checkIdentity(identity); err != nil {
					return err
				}
				r.setToken(token)
				return nil
			case hubclient.IsUnauthorized(identityErr):
				// 缓存 token 已被撤销/轮换：继续尝试配置里的新 token。
			default:
				// hub 暂时不可达时保持离线启动能力，后续心跳会暴露网络错误。
				r.setToken(token)
				return nil
			}
		}
	}

	candidates := make([]string, 0, 2)
	if inline := strings.TrimSpace(r.Config.Agent.Token); inline != "" {
		candidates = append(candidates, inline)
	}
	if r.Config.Agent.TokenFile != "" {
		if data, err := os.ReadFile(r.Config.Agent.TokenFile); err == nil {
			candidates = append(candidates, strings.TrimSpace(string(data)))
		}
	}

	seen := make(map[string]struct{}, len(candidates))
	var lastAuthErr error
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}

		identity, err := r.Client.Identity(ctx, candidate)
		if err == nil {
			if err := r.checkIdentity(identity); err != nil {
				return err
			}
			if err := r.saveToken(cachedPath, candidate); err != nil {
				return err
			}
			r.setToken(candidate)
			return nil
		}
		if !hubclient.IsUnauthorized(err) {
			return fmt.Errorf("validate token: %w", err)
		}

		response, enrollErr := r.Client.Enroll(ctx, candidate, r.enrollRequest())
		if enrollErr == nil {
			if err := r.saveToken(cachedPath, response.Token); err != nil {
				return err
			}
			r.setToken(response.Token)
			return nil
		}
		if !hubclient.IsUnauthorized(enrollErr) {
			return fmt.Errorf("enroll: %w", enrollErr)
		}
		lastAuthErr = enrollErr
	}

	if enrollToken == "" {
		enrollToken = os.Getenv("OBSERVER_ENROLL_TOKEN")
	}
	enrollToken = strings.TrimSpace(enrollToken)
	if enrollToken != "" {
		response, err := r.Client.Enroll(ctx, enrollToken, r.enrollRequest())
		if err != nil {
			return fmt.Errorf("enroll: %w", err)
		}
		if err := r.saveToken(cachedPath, response.Token); err != nil {
			return err
		}
		r.setToken(response.Token)
		return nil
	}

	if lastAuthErr != nil {
		return fmt.Errorf("agent token invalid or expired: %w", lastAuthErr)
	}
	return errors.New("agent not enrolled: set agent.token, OBSERVER_ENROLL_TOKEN or pass --enroll-token")
}

func (r *Runner) checkIdentity(identity *hubclient.IdentityResponse) error {
	if identity.MachineID != r.Config.Agent.MachineID {
		return fmt.Errorf(
			"token belongs to machine %q, but config machine_id is %q",
			identity.MachineID,
			r.Config.Agent.MachineID,
		)
	}
	return nil
}

func (r *Runner) saveToken(cachedPath, token string) error {
	if err := os.MkdirAll(filepath.Dir(cachedPath), 0o700); err != nil {
		return fmt.Errorf("create state dir: %w", err)
	}
	if err := os.WriteFile(cachedPath, []byte(token+"\n"), 0o600); err != nil {
		return fmt.Errorf("save agent token: %w", err)
	}
	if r.Config.Agent.TokenFile != "" {
		if err := os.WriteFile(r.Config.Agent.TokenFile, []byte(token+"\n"), 0o600); err != nil {
			return fmt.Errorf("save token: %w", err)
		}
	}
	return nil
}

// RunOnce 执行一轮：补发 spool → 心跳 → 清单同步 → 执行任务（如有）。
func (r *Runner) RunOnce(ctx context.Context) (scan.Stats, error) {
	if r.agentToken() == "" {
		if err := r.EnsureToken(ctx, os.Getenv("OBSERVER_ENROLL_TOKEN")); err != nil {
			return scan.Stats{}, err
		}
	}

	if err := r.ensureMountsSynced(ctx); err != nil {
		return scan.Stats{}, err
	}

	r.flushSpool(ctx)

	beat, err := r.Client.Heartbeat(ctx, r.agentToken(), hubclient.HeartbeatRequest{AgentVersion: r.Version})
	if err != nil {
		return scan.Stats{}, fmt.Errorf("heartbeat: %w", err)
	}
	if err := r.syncManifests(ctx, beat); err != nil {
		return scan.Stats{}, fmt.Errorf("manifest sync: %w", err)
	}
	r.processRepairs(ctx, beat)
	if beat.Job == nil {
		return scan.Stats{}, nil
	}

	mount, ok := r.findMount(beat.Job.MountID)
	if !ok {
		return scan.Stats{}, fmt.Errorf("hub dispatched unknown mount %q", beat.Job.MountID)
	}

	job := scan.Job{
		ID:      beat.Job.ID,
		MountPk: beat.Job.MountPk,
		MountID: beat.Job.MountID,
		Mode:    beat.Job.Mode,
	}
	r.setCurrent(CurrentJob{
		JobID:     job.ID,
		MountID:   job.MountID,
		Mode:      job.Mode,
		StartedAt: r.Now().UnixMilli(),
	})
	defer r.clearCurrent()

	stats, err := scan.Run(ctx, scan.Options{
		Mount:      mount,
		Job:        job,
		Cache:      r.Cache,
		Client:     r.Client,
		AgentToken: r.agentToken(),
		Spool:      r.Spool,
		Now:        r.Now,
		Progress:   r.updateProgress,
	})
	return stats, err
}

// processRepairs 处理心跳下发的修复中转/应用任务（每轮最多各一个）。
func (r *Runner) processRepairs(ctx context.Context, beat *hubclient.HeartbeatResponse) {
	for _, task := range beat.Transfers {
		if err := repair.UploadSource(ctx, r.Client, r.agentToken(), r.Config, task); err != nil && !errors.Is(err, context.Canceled) {
			fmt.Fprintf(os.Stderr, "observer-agent: repair upload %d: %v\n", task.TicketID, err)
		}
	}
	for _, task := range beat.Repairs {
		if err := repair.ApplyTarget(ctx, r.Client, r.agentToken(), r.Config, task); err != nil && !errors.Is(err, context.Canceled) {
			fmt.Fprintf(os.Stderr, "observer-agent: repair apply %d: %v\n", task.RepairID, err)
		}
	}
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

	if r.Config.Agent.Token == "" && r.Config.Agent.TokenFile != "" {
		if _, err := os.Stat(r.Config.Agent.TokenFile); err != nil {
			problems = append(problems, fmt.Sprintf("token file %s: %v", r.Config.Agent.TokenFile, err))
		}
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

// ensureMountsSynced 在首次心跳前把当前配置的挂载点同步到 hub。
// 这样 GUI 新增/修改/删除挂载点后，重启 runner 即可生效，无需重新注册。
func (r *Runner) ensureMountsSynced(ctx context.Context) error {
	if r.mountsSynced {
		return nil
	}
	if _, err := r.Client.SyncMounts(ctx, r.agentToken(), r.enrollMounts()); err != nil {
		return fmt.Errorf("sync mounts: %w", err)
	}
	r.mountsSynced = true
	return nil
}

func (r *Runner) enrollMounts() []hubclient.EnrollMount {
	mounts := make([]hubclient.EnrollMount, 0, len(r.Config.Mounts))
	for _, mount := range r.Config.Mounts {
		include := mount.Include
		if include == nil {
			include = []string{}
		}
		exclude := mount.Exclude
		if exclude == nil {
			exclude = []string{}
		}
		mounts = append(mounts, hubclient.EnrollMount{
			MountID:       mount.ID,
			Label:         mount.Label,
			PhysicalPath:  mount.Path,
			Sentinel:      mount.Sentinel,
			FSKind:        mount.FSKind,
			CaseSensitive: mount.CaseSensitive,
			Unicode:       mount.Unicode,
			Include:       include,
			Exclude:       exclude,
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
				"interval_minutes":       mount.Schedule.IntervalMinutes,
			},
			RepairAllowed: mount.RepairAllowed != nil && *mount.RepairAllowed,
		})
	}
	return mounts
}

func (r *Runner) enrollRequest() hubclient.EnrollRequest {
	hostname, _ := os.Hostname()
	return hubclient.EnrollRequest{
		MachineID:    r.Config.Agent.MachineID,
		Label:        r.Config.Agent.Label,
		Hostname:     hostname,
		Platform:     runtime.GOOS,
		Arch:         runtime.GOARCH,
		AgentVersion: r.Version,
		Mounts:       r.enrollMounts(),
	}
}

func (r *Runner) flushSpool(ctx context.Context) {
	batches, err := r.Spool.ReadAll()
	if err != nil || len(batches) == 0 {
		return
	}
	remaining := make([]spool.Batch, 0, len(batches))
	for _, batch := range batches {
		_, submitErr := r.Client.SubmitResults(ctx, r.agentToken(), batch.JobID, batch.Seq, batch.Entries)
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
	PathKey  string `json:"k"`
	Size     int64  `json:"s"`
	MtimeNs  string `json:"m"`
	HashedAt int64  `json:"h"`
}

func (r *Runner) pullManifest(ctx context.Context, mountID string, mountPk int64) error {
	body, err := r.Client.Manifest(ctx, r.agentToken(), mountPk)
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
