// Package spool 是离线结果队列（JSONL）：hub 不可达时先落盘，恢复后按序补发。
package spool

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"observer/agent/internal/hubclient"
)

// Batch 是一条待补发的结果批次。
type Batch struct {
	JobID   int64             `json:"job_id"`
	Seq     int64             `json:"seq"`
	Entries []hubclient.Entry `json:"entries"`
}

// Spool 是文件队列。
type Spool struct {
	path string
	mu   sync.Mutex
}

// Open 打开（或创建）队列文件。
func Open(path string) (*Spool, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	return &Spool{path: file.Name()}, file.Close()
}

// Append 追加一条批次并 fsync。
func (s *Spool) Append(batch Batch) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	file, err := os.OpenFile(s.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()

	encoded, err := json.Marshal(batch)
	if err != nil {
		return err
	}
	if _, err := file.Write(append(encoded, '\n')); err != nil {
		return err
	}
	return file.Sync()
}

// ReadAll 读取所有待补发批次。
func (s *Spool) ReadAll() ([]Batch, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	file, err := os.Open(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer file.Close()

	var batches []Batch
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1<<20), 8<<20)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var batch Batch
		if err := json.Unmarshal(line, &batch); err != nil {
			continue // 跳过损坏行，保命
		}
		batches = append(batches, batch)
	}
	return batches, scanner.Err()
}

// Replace 用剩余批次原子重写队列文件。
func (s *Spool) Replace(batches []Batch) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	temp := s.path + ".tmp"
	file, err := os.OpenFile(temp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	writer := bufio.NewWriter(file)
	for _, batch := range batches {
		encoded, err := json.Marshal(batch)
		if err != nil {
			file.Close()
			return err
		}
		if _, err := writer.Write(append(encoded, '\n')); err != nil {
			file.Close()
			return err
		}
	}
	if err := writer.Flush(); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(temp, s.path)
}

// Path 返回队列文件路径（诊断用）。
func (s *Spool) Path() string {
	return s.path
}
