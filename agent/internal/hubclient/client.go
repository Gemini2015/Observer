// Package hubclient 是 agent 访问中心服的最小 HTTP 客户端。
package hubclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Entry struct {
	PathKey        string `json:"path_key"`
	PathDisplayB64 string `json:"path_display_b64"`
	Size           int64  `json:"size"`
	MtimeNs        string `json:"mtime_ns"`
	Hash           string `json:"hash,omitempty"`
	Status         string `json:"status"`
	SkipReason     string `json:"skip_reason,omitempty"`
}

type EnrollMount struct {
	MountID       string         `json:"mount_id"`
	Label         string         `json:"label,omitempty"`
	PhysicalPath  string         `json:"physical_path"`
	Sentinel      string         `json:"sentinel,omitempty"`
	FSKind        string         `json:"fs_kind"`
	CaseSensitive string         `json:"case_sensitive"`
	Unicode       string         `json:"unicode"`
	Include       []string       `json:"include"`
	Exclude       []string       `json:"exclude"`
	RulesHash     string         `json:"rules_hash"`
	Limits        map[string]any `json:"limits"`
	Schedule      map[string]any `json:"schedule"`
	RepairAllowed bool           `json:"repair_allowed"`
}

type EnrollRequest struct {
	MachineID    string        `json:"machine_id"`
	Label        string        `json:"label,omitempty"`
	Hostname     string        `json:"hostname,omitempty"`
	Platform     string        `json:"platform,omitempty"`
	Arch         string        `json:"arch,omitempty"`
	AgentVersion string        `json:"agent_version,omitempty"`
	Mounts       []EnrollMount `json:"mounts"`
}

type MountRef struct {
	ID            int64  `json:"id"`
	MountID       string `json:"mount_id"`
	ManifestEpoch int64  `json:"manifest_epoch"`
}

type EnrollResponse struct {
	AgentID   int64      `json:"agent_id"`
	Token     string     `json:"token"`
	MachineID string     `json:"machine_id"`
	Protocol  int64      `json:"protocol"`
	Mounts    []MountRef `json:"mounts"`
}

type HeartbeatRequest struct {
	AgentVersion string `json:"agent_version,omitempty"`
}

type Job struct {
	ID         int64  `json:"id"`
	MountPk    int64  `json:"mount_pk"`
	MountID    string `json:"mount_id"`
	Mode       string `json:"mode"`
	LeaseUntil int64  `json:"lease_until"`
}

type HeartbeatResponse struct {
	ServerTime int64          `json:"server_time"`
	DBInstance string         `json:"db_instance"`
	Job        *Job           `json:"job"`
	Cancel     bool           `json:"cancel"`
	Mounts     []MountRef     `json:"mounts"`
	Transfers  []TransferTask `json:"transfers"`
	Repairs    []RepairTask   `json:"repairs"`
}

type TransferTask struct {
	TicketID     int64  `json:"ticket_id"`
	RepairID     int64  `json:"repair_id"`
	MountID      string `json:"mount_id"`
	PathKey      string `json:"path_key"`
	Size         int64  `json:"size"`
	ExpectedHash string `json:"expected_hash"`
	Offset       int64  `json:"offset"`
	Status       string `json:"status"`
}

type RepairTask struct {
	RepairID     int64  `json:"repair_id"`
	TicketID     int64  `json:"ticket_id"`
	MountID      string `json:"mount_id"`
	PathKey      string `json:"path_key"`
	Size         int64  `json:"size"`
	ExpectedHash string `json:"expected_hash"`
	ObservedHash string `json:"observed_hash"`
	TargetState  string `json:"target_state"`
}

type Guard struct {
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

type FinishRequest struct {
	Status string         `json:"status"`
	Stats  map[string]any `json:"stats,omitempty"`
	Guard  *Guard         `json:"guard,omitempty"`
}

type Coverage struct {
	Total  int64   `json:"total"`
	Hashed int64   `json:"hashed"`
	Ratio  float64 `json:"ratio"`
}

type FinishResponse struct {
	OK        bool     `json:"ok"`
	JobStatus string   `json:"job_status"`
	Coverage  Coverage `json:"coverage"`
}

type BatchResponse struct {
	Accepted      int   `json:"accepted"`
	Duplicate     bool  `json:"duplicate"`
	ManifestEpoch int64 `json:"manifest_epoch"`
}

// Problem 是 hub 返回的 application/problem+json。
type Problem struct {
	Type      string `json:"type"`
	Title     string `json:"title"`
	Status    int    `json:"status"`
	Detail    string `json:"detail"`
	Retryable bool   `json:"retryable"`
}

func (p *Problem) Error() string {
	if p.Detail != "" {
		return fmt.Sprintf("hub error %d %s: %s", p.Status, p.Title, p.Detail)
	}
	return fmt.Sprintf("hub error %d %s", p.Status, p.Title)
}

// Client 是 hub 客户端。
type Client struct {
	baseURL      string
	agentVersion string
	http         *http.Client
}

// New 创建客户端。
func New(baseURL, agentVersion string) *Client {
	return &Client{
		baseURL:      strings.TrimRight(baseURL, "/"),
		agentVersion: agentVersion,
		http:         &http.Client{Timeout: 60 * time.Second},
	}
}

// Enroll 用一次性 token 注册。
func (c *Client) Enroll(ctx context.Context, enrollToken string, request EnrollRequest) (*EnrollResponse, error) {
	var response EnrollResponse
	headers := map[string]string{"x-observer-enroll-token": enrollToken}
	if err := c.doJSON(ctx, http.MethodPost, "/api/v1/enroll", "", headers, request, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

// IdentityMount 是 hub 上已注册 mount 的完整配置（用于重连时自动填充）。
type IdentityMount struct {
	MountID       string         `json:"mount_id"`
	Label         string         `json:"label"`
	PhysicalPath  string         `json:"physical_path"`
	Sentinel      string         `json:"sentinel"`
	FSKind        string         `json:"fs_kind"`
	CaseSensitive string         `json:"case_sensitive"`
	Unicode       string         `json:"unicode"`
	Include       []string       `json:"include"`
	Exclude       []string       `json:"exclude"`
	RulesHash     string         `json:"rules_hash"`
	Limits        map[string]any `json:"limits"`
	Schedule      map[string]any `json:"schedule"`
	RepairAllowed bool           `json:"repair_allowed"`
	State         string         `json:"state"`
}

// IdentityResponse 是接入 token 对应节点的身份与挂载点。
type IdentityResponse struct {
	AgentID   int64           `json:"agent_id"`
	MachineID string          `json:"machine_id"`
	Label     string          `json:"label"`
	Hostname  string          `json:"hostname"`
	Platform  string          `json:"platform"`
	Arch      string          `json:"arch"`
	Mounts    []IdentityMount `json:"mounts"`
}

// Identity 用长期 agent token 校验身份并拉取自己的挂载点配置。
func (c *Client) Identity(ctx context.Context, agentToken string) (*IdentityResponse, error) {
	var response IdentityResponse
	if err := c.doJSON(ctx, http.MethodGet, "/api/v1/agent/identity", agentToken, nil, nil, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

// Heartbeat 发送心跳，返回任务与清单版本。
func (c *Client) Heartbeat(ctx context.Context, agentToken string, request HeartbeatRequest) (*HeartbeatResponse, error) {
	var response HeartbeatResponse
	if err := c.doJSON(ctx, http.MethodPost, "/api/v1/agent/heartbeat", agentToken, nil, request, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

// JobSummary 是 agent 自己的历史任务摘要（来自 hub）。
type JobSummary struct {
	ID         int64          `json:"id"`
	Mode       string         `json:"mode"`
	Status     string         `json:"status"`
	Attempt    int            `json:"attempt"`
	CreatedAt  int64          `json:"created_at"`
	StartedAt  *int64         `json:"started_at"`
	FinishedAt *int64         `json:"finished_at"`
	Stats      map[string]any `json:"stats"`
	MountID    string         `json:"mount_id"`
	MachineID  string         `json:"machine_id"`
}

// ListJobs 拉取本 agent 所属机器最近的扫描任务。
func (c *Client) ListJobs(ctx context.Context, agentToken string, limit int) ([]JobSummary, error) {
	if limit <= 0 {
		limit = 20
	}
	var result []JobSummary
	path := fmt.Sprintf("/api/v1/agent/jobs?limit=%d", limit)
	if err := c.doJSON(ctx, http.MethodGet, path, agentToken, nil, nil, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// MountSyncResponse 是挂载点同步结果。
type MountSyncResponse struct {
	Mounts []MountRef `json:"mounts"`
}

// SyncMounts 把 agent 当前挂载点配置同步到 hub（新增/更新/软删除）。
func (c *Client) SyncMounts(ctx context.Context, agentToken string, mounts []EnrollMount) ([]MountRef, error) {
	body := map[string]any{"mounts": mounts}
	var response MountSyncResponse
	if err := c.doJSON(ctx, http.MethodPut, "/api/v1/agent/mounts", agentToken, nil, body, &response); err != nil {
		return nil, err
	}
	return response.Mounts, nil
}

// SubmitResults 上报一批结果。
func (c *Client) SubmitResults(ctx context.Context, agentToken string, jobID, seq int64, entries []Entry) (*BatchResponse, error) {
	body := map[string]any{"seq": seq, "entries": entries}
	var response BatchResponse
	path := fmt.Sprintf("/api/v1/jobs/%d/results", jobID)
	if err := c.doJSON(ctx, http.MethodPost, path, agentToken, nil, body, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

// Finish 结束任务。
func (c *Client) Finish(ctx context.Context, agentToken string, jobID int64, request FinishRequest) (*FinishResponse, error) {
	var response FinishResponse
	path := fmt.Sprintf("/api/v1/jobs/%d/finish", jobID)
	if err := c.doJSON(ctx, http.MethodPost, path, agentToken, nil, request, &response); err != nil {
		return nil, err
	}
	return &response, nil
}

// Manifest 拉取路径清单流（NDJSON，Go 会自动解压 gzip）。
func (c *Client) Manifest(ctx context.Context, agentToken string, mountPk int64) (io.ReadCloser, error) {
	path := fmt.Sprintf("%s/api/v1/mounts/%d/manifest", c.baseURL, mountPk)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+agentToken)
	request.Header.Set("Observer-Agent-Version", c.agentVersion)

	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		defer response.Body.Close()
		return nil, decodeProblem(response)
	}
	return response.Body, nil
}

// Health 检查 hub 可达性。
func (c *Client) Health(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/healthz", nil)
	if err != nil {
		return err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return decodeProblem(response)
	}
	return nil
}

func (c *Client) doJSON(
	ctx context.Context,
	method, path, agentToken string,
	headers map[string]string,
	body any,
	result any,
) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}

	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Observer-Agent-Version", c.agentVersion)
	if agentToken != "" {
		request.Header.Set("Authorization", "Bearer "+agentToken)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}

	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	if response.StatusCode >= 400 {
		return decodeProblem(response)
	}
	if result == nil {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	return json.NewDecoder(response.Body).Decode(result)
}

func decodeProblem(response *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	problem := &Problem{Status: response.StatusCode, Title: response.Status}
	if err := json.Unmarshal(raw, problem); err != nil {
		return &Problem{
			Status: response.StatusCode,
			Title:  response.Status,
			Detail: strings.TrimSpace(string(raw)),
		}
	}
	return problem
}

// IsUnauthorized 判断是否为 token 无效/被撤销（401）。
func IsUnauthorized(err error) bool {
	problem, ok := err.(*Problem)
	return ok && problem.Status == http.StatusUnauthorized
}

// IsRetryable 判断错误是否值得重试（网络错误或 5xx）。
func IsRetryable(err error) bool {
	if err == nil {
		return false
	}
	var problem *Problem
	if ok := asProblem(err, &problem); ok {
		return problem.Retryable || problem.Status >= 500
	}
	return true
}

func asProblem(err error, target **Problem) bool {
	problem, ok := err.(*Problem)
	if !ok {
		return false
	}
	*target = problem
	return true
}

// TransferChunkResponse 是上传分块后的状态。
type TransferChunkResponse struct {
	BytesReceived int64  `json:"bytes_received"`
	Size          int64  `json:"size"`
	Status        string `json:"status"`
	Error         string `json:"error"`
}

// RepairResultRequest 是目标端修复结果上报。
type RepairResultRequest struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
	Hash    string `json:"hash,omitempty"`
	Size    int64  `json:"size,omitempty"`
	MtimeNS string `json:"mtime_ns,omitempty"`
}

// UploadTransferChunk 上传修复中转分块（源端）。
func (c *Client) UploadTransferChunk(ctx context.Context, agentToken string, ticketID, offset int64, data []byte) (*TransferChunkResponse, error) {
	url := fmt.Sprintf("%s/api/v1/transfers/%d/data?offset=%d", c.baseURL, ticketID, offset)
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("Authorization", "Bearer "+agentToken)
	request.Header.Set("Observer-Agent-Version", c.agentVersion)

	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return nil, decodeProblem(response)
	}
	var result TransferChunkResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}

// DownloadTransferChunk 下载修复中转分块（目标端），返回数据与文件总大小。
func (c *Client) DownloadTransferChunk(ctx context.Context, agentToken string, ticketID, offset int64) ([]byte, int64, error) {
	url := fmt.Sprintf("%s/api/v1/transfers/%d/data?offset=%d", c.baseURL, ticketID, offset)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Authorization", "Bearer "+agentToken)
	request.Header.Set("Observer-Agent-Version", c.agentVersion)

	response, err := c.http.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return nil, 0, decodeProblem(response)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return nil, 0, err
	}
	total, _ := strconv.ParseInt(response.Header.Get("x-observer-size"), 10, 64)
	return data, total, nil
}

// FailTransfer 由源端报告上传失败。
func (c *Client) FailTransfer(ctx context.Context, agentToken string, ticketID int64, reason string) error {
	path := fmt.Sprintf("/api/v1/transfers/%d/fail", ticketID)
	return c.doJSON(ctx, http.MethodPost, path, agentToken, nil, map[string]string{"reason": reason}, nil)
}

// ReportRepair 由目标端上报修复结果。
func (c *Client) ReportRepair(ctx context.Context, agentToken string, repairID int64, request RepairResultRequest) error {
	path := fmt.Sprintf("/api/v1/repairs/%d/result", repairID)
	return c.doJSON(ctx, http.MethodPost, path, agentToken, nil, request, nil)
}
