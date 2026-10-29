// Package hashfile 提供流式 SHA-256 文件哈希。
package hashfile

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
)

const defaultBufferSize = 1 << 20 // 1 MiB

// SumFile 流式计算文件 SHA-256。onChunk 在每次读取后回调，可用于字节限速。
// 返回十六进制摘要与读取字节数。
func SumFile(path string, buffer []byte, onChunk func(int) error) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()

	if len(buffer) == 0 {
		buffer = make([]byte, defaultBufferSize)
	}

	hasher := sha256.New()
	var total int64
	for {
		read, readErr := file.Read(buffer)
		if read > 0 {
			if _, writeErr := hasher.Write(buffer[:read]); writeErr != nil {
				return "", total, writeErr
			}
			total += int64(read)
			if onChunk != nil {
				if err := onChunk(read); err != nil {
					return "", total, err
				}
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return "", total, readErr
		}
	}

	return hex.EncodeToString(hasher.Sum(nil)), total, nil
}
