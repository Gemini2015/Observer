// Package repair 实现跨机修复的 agent 侧执行：源端上传、目标端下载校验/隔离/替换。
package repair

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"observer/agent/internal/config"
	"observer/agent/internal/hubclient"
)

const chunkSize = 1 << 20

// Uploader 是源端需要的最小 hub 能力。
type Uploader interface {
	UploadTransferChunk(ctx context.Context, agentToken string, ticketID, offset int64, data []byte) (*hubclient.TransferChunkResponse, error)
	FailTransfer(ctx context.Context, agentToken string, ticketID int64, reason string) error
}

// Applier 是目标端需要的最小 hub 能力。
type Applier interface {
	DownloadTransferChunk(ctx context.Context, agentToken string, ticketID, offset int64) ([]byte, int64, error)
	ReportRepair(ctx context.Context, agentToken string, repairID int64, request hubclient.RepairResultRequest) error
}

func findMount(cfg *config.Config, mountID string) (config.Mount, error) {
	for _, mount := range cfg.Mounts {
		if mount.ID == mountID {
			return mount, nil
		}
	}
	return config.Mount{}, fmt.Errorf("unknown mount %q", mountID)
}

// resolveLocal 把相对路径限制在 mount 内，拒绝越界/绝对路径。
func resolveLocal(mount config.Mount, relPath string) (string, error) {
	if relPath == "" {
		return "", errors.New("empty path")
	}
	clean := filepath.Clean(filepath.FromSlash(relPath))
	if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path outside mount: %s", relPath)
	}
	local := filepath.Join(mount.Path, clean)
	rel, err := filepath.Rel(mount.Path, local)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path outside mount: %s", relPath)
	}
	return local, nil
}

func hashFile(filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func mtimeNS(info os.FileInfo) string {
	return strconv.FormatInt(info.ModTime().UnixNano(), 10)
}

// UploadSource 源端：校验本地哈希后按 offset 分块上传。
func UploadSource(ctx context.Context, hub Uploader, token string, cfg *config.Config, task hubclient.TransferTask) error {
	mount, err := findMount(cfg, task.MountID)
	if err != nil {
		_ = hub.FailTransfer(ctx, token, task.TicketID, err.Error())
		return err
	}
	local, err := resolveLocal(mount, task.PathKey)
	if err != nil {
		_ = hub.FailTransfer(ctx, token, task.TicketID, err.Error())
		return err
	}
	fail := func(reason string) error {
		_ = hub.FailTransfer(ctx, token, task.TicketID, reason)
		return errors.New(reason)
	}

	expected := strings.ToLower(task.ExpectedHash)
	actual, err := hashFile(local)
	if err != nil {
		return fail(fmt.Sprintf("read source failed: %v", err))
	}
	if actual != expected {
		return fail("source hash mismatch")
	}
	info, err := os.Stat(local)
	if err != nil {
		return fail(fmt.Sprintf("stat source failed: %v", err))
	}
	if info.Size() != task.Size {
		return fail("source size changed")
	}
	offset := task.Offset
	if offset < 0 || offset > info.Size() {
		return fail("invalid resume offset")
	}

	file, err := os.Open(local)
	if err != nil {
		return fail(fmt.Sprintf("open source failed: %v", err))
	}
	defer file.Close()
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return fail(fmt.Sprintf("seek source failed: %v", err))
	}

	buffer := make([]byte, chunkSize)
	for offset < info.Size() {
		read, readErr := file.Read(buffer)
		if read > 0 {
			response, uploadErr := hub.UploadTransferChunk(ctx, token, task.TicketID, offset, buffer[:read])
			if uploadErr != nil {
				return uploadErr // 网络/临时错误：下一轮心跳重试
			}
			offset += int64(read)
			if response.Status == "failed" {
				return errors.New(response.Error)
			}
			if response.Status == "ready" {
				return nil
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return fail(fmt.Sprintf("read source failed: %v", readErr))
		}
	}
	return nil
}

// ApplyTarget 目标端：下载校验 → 隔离坏文件 → 原子替换 → 复核上报。
func ApplyTarget(ctx context.Context, hub Applier, token string, cfg *config.Config, task hubclient.RepairTask) error {
	mount, err := findMount(cfg, task.MountID)
	if err != nil {
		_ = hub.ReportRepair(ctx, token, task.RepairID, hubclient.RepairResultRequest{Success: false, Error: err.Error()})
		return err
	}
	local, err := resolveLocal(mount, task.PathKey)
	if err != nil {
		_ = hub.ReportRepair(ctx, token, task.RepairID, hubclient.RepairResultRequest{Success: false, Error: err.Error()})
		return err
	}
	expected := strings.ToLower(task.ExpectedHash)
	reportFailure := func(reason string) error {
		_ = hub.ReportRepair(ctx, token, task.RepairID, hubclient.RepairResultRequest{Success: false, Error: reason})
		return errors.New(reason)
	}
	reportSuccess := func(info os.FileInfo) error {
		return hub.ReportRepair(ctx, token, task.RepairID, hubclient.RepairResultRequest{
			Success: true,
			Hash:    expected,
			Size:    info.Size(),
			MtimeNS: mtimeNS(info),
		})
	}

	// 幂等：若目标已经是期望内容（上次上报丢失），直接报成功。
	if info, statErr := os.Stat(local); statErr == nil {
		if current, hashErr := hashFile(local); hashErr == nil && current == expected {
			return reportSuccess(info)
		}
	}

	dir := filepath.Dir(local)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return reportFailure(fmt.Sprintf("create target dir failed: %v", err))
	}
	temp, err := os.CreateTemp(dir, ".observer-repair-*.tmp")
	if err != nil {
		return reportFailure(fmt.Sprintf("create temp failed: %v", err))
	}
	tempName := temp.Name()
	cleanup := func() {
		_ = temp.Close()
		_ = os.Remove(tempName)
	}
	defer cleanup()

	hash := sha256.New()
	var offset int64
	for {
		data, total, downloadErr := hub.DownloadTransferChunk(ctx, token, task.TicketID, offset)
		if downloadErr != nil {
			return downloadErr // 临时错误：下一轮心跳重试
		}
		if len(data) == 0 {
			return reportFailure("empty transfer chunk")
		}
		if _, writeErr := temp.Write(data); writeErr != nil {
			return reportFailure(fmt.Sprintf("write temp failed: %v", writeErr))
		}
		_, _ = hash.Write(data)
		offset += int64(len(data))
		if total <= 0 {
			total = task.Size
		}
		if offset > total {
			return reportFailure("download exceeds expected size")
		}
		if offset == total {
			break
		}
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if actual != expected {
		return reportFailure("downloaded hash mismatch")
	}
	if err := temp.Sync(); err != nil {
		return reportFailure(fmt.Sprintf("fsync temp failed: %v", err))
	}
	if err := temp.Close(); err != nil {
		return reportFailure(fmt.Sprintf("close temp failed: %v", err))
	}

	// 替换前校验目标当前状态，避免覆盖用户的新改动。
	targetExists := false
	if info, statErr := os.Stat(local); statErr == nil {
		targetExists = true
		current, hashErr := hashFile(local)
		if hashErr != nil {
			return reportFailure(fmt.Sprintf("read target failed: %v", hashErr))
		}
		if task.ObservedHash != "" {
			if current != strings.ToLower(task.ObservedHash) {
				return reportFailure("target changed since issue was reported")
			}
		} else if current == expected {
			return reportFailure("target already matches trusted hash")
		}
		_ = info
	} else if task.TargetState != "missing" && !errors.Is(statErr, os.ErrNotExist) {
		return reportFailure(fmt.Sprintf("stat target failed: %v", statErr))
	} else if task.TargetState == "active" && errors.Is(statErr, os.ErrNotExist) {
		return reportFailure("target missing unexpectedly")
	}

	quarantinePath := ""
	if targetExists {
		quarantineDir := filepath.Join(mount.Path, ".observer-quarantine")
		quarantinePath = filepath.Join(
			quarantineDir,
			filepath.FromSlash(task.PathKey)+"."+strconv.FormatInt(time.Now().UnixMilli(), 10),
		)
		if err := os.MkdirAll(filepath.Dir(quarantinePath), 0o755); err != nil {
			return reportFailure(fmt.Sprintf("create quarantine dir failed: %v", err))
		}
		if err := os.Rename(local, quarantinePath); err != nil {
			return reportFailure(fmt.Sprintf("quarantine failed: %v", err))
		}
	}

	if err := os.Rename(tempName, local); err != nil {
		if quarantinePath != "" {
			_ = os.Rename(quarantinePath, local)
		}
		return reportFailure(fmt.Sprintf("atomic replace failed: %v", err))
	}

	info, err := os.Stat(local)
	if err != nil {
		return reportFailure(fmt.Sprintf("stat replaced target failed: %v", err))
	}
	// 复核哈希，确认替换后的文件可信。
	if current, hashErr := hashFile(local); hashErr != nil || current != expected {
		return reportFailure("post-replace hash mismatch")
	}
	return reportSuccess(info)
}
