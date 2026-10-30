package main

import (
	"context"
	"errors"
	"strings"
	"time"

	agentcore "observer/agent/internal/agent"
	"observer/agent/internal/hubclient"
)

// FileQuery 是桌面端文件列表查询参数。
type FileQuery struct {
	Q       string `json:"q"`
	MountID string `json:"mount_id"`
	State   string `json:"state"`
	Issue   string `json:"issue"`
	Hash    string `json:"hash"`
	SizeMin *int64 `json:"size_min"`
	SizeMax *int64 `json:"size_max"`
	Sort    string `json:"sort"`
	Order   string `json:"order"`
	Limit   int    `json:"limit"`
	Offset  int    `json:"offset"`
}

type FileSummary struct {
	Total         int `json:"total"`
	Active        int `json:"active"`
	Missing       int `json:"missing"`
	OutOfScope    int `json:"out_of_scope"`
	Hashed        int `json:"hashed"`
	Unhashed      int `json:"unhashed"`
	OpenIssuePath int `json:"open_issue_paths"`
}

type FileItemView struct {
	ID             int64  `json:"id"`
	MachineID      string `json:"machine_id"`
	MachineLabel   string `json:"machine_label"`
	MountPk        int64  `json:"mount_pk"`
	MountID        string `json:"mount_id"`
	MountLabel     string `json:"mount_label"`
	PathKey        string `json:"path_key"`
	PathDisplayB64 string `json:"path_display_b64"`
	State          string `json:"state"`
	Size           int64  `json:"size"`
	MtimeNs        string `json:"mtime_ns"`
	ContentHash    string `json:"content_hash"`
	LastSeenAt     *int64 `json:"last_seen_at"`
	LastHashedAt   *int64 `json:"last_hashed_at"`
	LastHashKind   string `json:"last_hash_kind"`
	OpenIssueCount int    `json:"open_issue_count"`
}

type FileList struct {
	Items   []FileItemView `json:"items"`
	Total   int            `json:"total"`
	Limit   int            `json:"limit"`
	Offset  int            `json:"offset"`
	Summary FileSummary    `json:"summary"`
}

type FileIssueView struct {
	ID          int64  `json:"id"`
	Type        string `json:"type"`
	Status      string `json:"status"`
	Confidence  string `json:"confidence"`
	Occurrences int    `json:"occurrences"`
	FirstSeenAt int64  `json:"first_seen_at"`
	LastSeenAt  int64  `json:"last_seen_at"`
	Evidence    any    `json:"evidence"`
}

type FileObservationView struct {
	Hash       string `json:"hash"`
	Kind       string `json:"kind"`
	ObservedAt int64  `json:"observed_at"`
}

type FileMachineView struct {
	MachineID string `json:"machine_id"`
	Label     string `json:"label"`
	Status    string `json:"status"`
	Platform  string `json:"platform"`
}

type FileMountView struct {
	ID           int64  `json:"id"`
	MountID      string `json:"mount_id"`
	Label        string `json:"label"`
	PhysicalPath string `json:"physical_path"`
	State        string `json:"state"`
}

type FileDetail struct {
	File         FileItemView          `json:"file"`
	Machine      FileMachineView       `json:"machine"`
	Mount        FileMountView         `json:"mount"`
	Issues       []FileIssueView       `json:"issues"`
	Observations []FileObservationView `json:"observations"`
}

// FileMountOption 是文件页挂载点下拉项。
type FileMountOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Path  string `json:"path"`
}

// FileService 向 GUI 暴露本机文件列表/详情（通过 hub 的 agent token 接口）。
type FileService struct {
	controller *controller
}

func (s *FileService) queryContext() (*agentcore.Runner, context.Context, context.CancelFunc, error) {
	if s.controller == nil {
		return nil, nil, nil, errors.New("desktop controller 未初始化")
	}
	s.controller.mu.Lock()
	runner := s.controller.runner
	parent := s.controller.appCtx
	s.controller.mu.Unlock()
	if runner == nil {
		return nil, nil, nil, errors.New("agent 尚未连接，请等待初始化完成")
	}
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	return runner, ctx, cancel, nil
}

func (s *FileService) ListFiles(query FileQuery) (FileList, error) {
	runner, ctx, cancel, err := s.queryContext()
	if err != nil {
		return FileList{}, err
	}
	defer cancel()

	hubQuery := hubclient.FileQuery{
		Q:       strings.TrimSpace(query.Q),
		MountID: strings.TrimSpace(query.MountID),
		State:   strings.TrimSpace(query.State),
		Issue:   strings.TrimSpace(query.Issue),
		Hash:    strings.TrimSpace(query.Hash),
		Sort:    strings.TrimSpace(query.Sort),
		Order:   strings.TrimSpace(query.Order),
		Limit:   query.Limit,
		Offset:  query.Offset,
	}
	if query.SizeMin != nil {
		hubQuery.SizeMin = query.SizeMin
	}
	if query.SizeMax != nil {
		hubQuery.SizeMax = query.SizeMax
	}
	result, err := runner.ListFiles(ctx, hubQuery)
	if err != nil {
		return FileList{}, err
	}
	return fileListFromHub(result), nil
}

func (s *FileService) FileDetail(pathID int64) (FileDetail, error) {
	runner, ctx, cancel, err := s.queryContext()
	if err != nil {
		return FileDetail{}, err
	}
	defer cancel()
	result, err := runner.FileDetail(ctx, pathID)
	if err != nil {
		return FileDetail{}, err
	}
	return fileDetailFromHub(result), nil
}

func (s *FileService) Mounts() ([]FileMountOption, error) {
	if s.controller == nil {
		return nil, errors.New("desktop controller 未初始化")
	}
	s.controller.mu.Lock()
	cfg := s.controller.cfg
	s.controller.mu.Unlock()
	if cfg == nil {
		return nil, errors.New("尚未配置 agent")
	}
	mounts := make([]FileMountOption, 0, len(cfg.Mounts))
	for _, mount := range cfg.Mounts {
		mounts = append(mounts, FileMountOption{ID: mount.ID, Label: mount.Label, Path: mount.Path})
	}
	return mounts, nil
}

func fileListFromHub(result *hubclient.FileListResponse) FileList {
	if result == nil {
		return FileList{}
	}
	items := make([]FileItemView, 0, len(result.Items))
	for _, item := range result.Items {
		items = append(items, fileItemFromHub(item))
	}
	summary := result.Summary
	return FileList{
		Items:  items,
		Total:  result.Total,
		Limit:  result.Limit,
		Offset: result.Offset,
		Summary: FileSummary{
			Total:         summary.Total,
			Active:        summary.Active,
			Missing:       summary.Missing,
			OutOfScope:    summary.OutOfScope,
			Hashed:        summary.Hashed,
			Unhashed:      summary.Unhashed,
			OpenIssuePath: summary.OpenIssuePath,
		},
	}
}

func fileItemFromHub(item hubclient.FileItem) FileItemView {
	return FileItemView{
		ID:             item.ID,
		MachineID:      item.MachineID,
		MachineLabel:   item.MachineLabel,
		MountPk:        item.MountPk,
		MountID:        item.MountID,
		MountLabel:     item.MountLabel,
		PathKey:        item.PathKey,
		PathDisplayB64: item.PathDisplayB64,
		State:          item.State,
		Size:           item.Size,
		MtimeNs:        item.MtimeNs,
		ContentHash:    item.ContentHash,
		LastSeenAt:     item.LastSeenAt,
		LastHashedAt:   item.LastHashedAt,
		LastHashKind:   item.LastHashKind,
		OpenIssueCount: item.OpenIssueCount,
	}
}

func fileDetailFromHub(result *hubclient.FileDetailResponse) FileDetail {
	if result == nil {
		return FileDetail{}
	}
	issues := make([]FileIssueView, 0, len(result.Issues))
	for _, issue := range result.Issues {
		issues = append(issues, FileIssueView{
			ID:          issue.ID,
			Type:        issue.Type,
			Status:      issue.Status,
			Confidence:  issue.Confidence,
			Occurrences: issue.Occurrences,
			FirstSeenAt: issue.FirstSeenAt,
			LastSeenAt:  issue.LastSeenAt,
			Evidence:    issue.Evidence,
		})
	}
	observations := make([]FileObservationView, 0, len(result.Observations))
	for _, observation := range result.Observations {
		observations = append(observations, FileObservationView{
			Hash:       observation.Hash,
			Kind:       observation.Kind,
			ObservedAt: observation.ObservedAt,
		})
	}
	return FileDetail{
		File: fileItemFromHub(result.File),
		Machine: FileMachineView{
			MachineID: result.Machine.MachineID,
			Label:     result.Machine.Label,
			Status:    result.Machine.Status,
			Platform:  result.Machine.Platform,
		},
		Mount: FileMountView{
			ID:           result.Mount.ID,
			MountID:      result.Mount.MountID,
			Label:        result.Mount.Label,
			PhysicalPath: result.Mount.PhysicalPath,
			State:        result.Mount.State,
		},
		Issues:       issues,
		Observations: observations,
	}
}
