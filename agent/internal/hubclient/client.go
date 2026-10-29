// Package hubclient 是 agent 访问中心服的最小 HTTP 客户端。
package hubclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
	AgentID  int64      `json:"agent_id"`
	Token    string     `json:"token"`
	MachineID string    `json:"machine_id"`
	Protocol int64      `json:"protocol"`
	Mounts   []MountRef `json:"mounts"`
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
	ServerTime  int64      `json:"server_time"`
	DBInstance  string     `json:"db_instance"`
	Job         *Job       `json:"job"`
	Cancel      bool       `json:"cancel"`
	Mounts      []MountRef `json:"mounts"`
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

// Heartbeat 发送心跳，返回任务与清单版本。
func (c *Client) Heartbeat(ctx context.Context, agentToken string, request HeartbeatRequest) (*HeartbeatResponse, error) {
	var response HeartbeatResponse
	if err := c.doJSON(ctx, http.MethodPost, "/api/v1/agent/heartbeat", agentToken, nil, request, &response); err != nil {
		return nil, err
	}
	return &response, nil
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
