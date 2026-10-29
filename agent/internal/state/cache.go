// Package state 是 agent 的本地状态缓存（bbolt）：用于跳过判定与清单版本对账。
// hub 仍是唯一真相源；缓存丢失只会导致从 hub 重新拉取清单或重算。
package state

import (
	"encoding/json"
	"fmt"
	"time"

	bolt "go.etcd.io/bbolt"
)

// FileState 是单个路径的本地状态。
type FileState struct {
	Size     int64  `json:"size"`
	MtimeNs  string `json:"mtime_ns"`
	HashedAt int64  `json:"hashed_at"` // epoch 毫秒
}

// Meta 是每个 mount 的同步元数据。
type Meta struct {
	DBInstance string `json:"db_instance"`
	Epoch      int64  `json:"manifest_epoch"`
	FullSyncAt int64  `json:"full_sync_at"`
}

// Cache 是 bbolt 封装的本地缓存。
type Cache struct {
	db *bolt.DB
}

var (
	filesBucketPrefix = []byte("files:")
	metaBucketPrefix  = []byte("meta:")
)

// Open 打开（或创建）缓存文件，带文件锁超时。
func Open(path string) (*Cache, error) {
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: 2 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("open state cache: %w", err)
	}
	return &Cache{db: db}, nil
}

// Close 关闭缓存。
func (c *Cache) Close() error {
	return c.db.Close()
}

// Get 读取路径状态。
func (c *Cache) Get(mountID, pathKey string) (FileState, bool, error) {
	var (
		result FileState
		found  bool
	)
	err := c.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(filesBucket(mountID))
		if bucket == nil {
			return nil
		}
		raw := bucket.Get([]byte(pathKey))
		if raw == nil {
			return nil
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			return err
		}
		found = true
		return nil
	})
	return result, found, err
}

// Put 写入路径状态。
func (c *Cache) Put(mountID, pathKey string, fileState FileState) error {
	return c.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(filesBucket(mountID))
		if err != nil {
			return err
		}
		raw, err := json.Marshal(fileState)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(pathKey), raw)
	})
}

// PutBatch 在一个事务内批量写入（清单同步用）。
func (c *Cache) PutBatch(mountID string, entries map[string]FileState) error {
	return c.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(filesBucket(mountID))
		if err != nil {
			return err
		}
		for pathKey, fileState := range entries {
			raw, err := json.Marshal(fileState)
			if err != nil {
				return err
			}
			if err := bucket.Put([]byte(pathKey), raw); err != nil {
				return err
			}
		}
		return nil
	})
}

// Delete 删除单个路径。
func (c *Cache) Delete(mountID, pathKey string) error {
	return c.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(filesBucket(mountID))
		if bucket == nil {
			return nil
		}
		return bucket.Delete([]byte(pathKey))
	})
}

// ClearMount 清空某个 mount 的缓存（换库或重建时使用）。
func (c *Cache) ClearMount(mountID string) error {
	return c.db.Update(func(tx *bolt.Tx) error {
		if tx.Bucket(filesBucket(mountID)) == nil {
			return nil
		}
		return tx.DeleteBucket(filesBucket(mountID))
	})
}

// Count 返回缓存的路径数量。
func (c *Cache) Count(mountID string) (int, error) {
	count := 0
	err := c.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(filesBucket(mountID))
		if bucket == nil {
			return nil
		}
		count = bucket.Stats().KeyN
		return nil
	})
	return count, err
}

// GetMeta 读取 mount 的同步元数据。
func (c *Cache) GetMeta(mountID string) (Meta, bool, error) {
	var (
		result Meta
		found  bool
	)
	err := c.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(metaBucket(mountID))
		if bucket == nil {
			return nil
		}
		raw := bucket.Get([]byte("meta"))
		if raw == nil {
			return nil
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			return err
		}
		found = true
		return nil
	})
	return result, found, err
}

// PutMeta 写入 mount 的同步元数据。
func (c *Cache) PutMeta(mountID string, meta Meta) error {
	return c.db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists(metaBucket(mountID))
		if err != nil {
			return err
		}
		raw, err := json.Marshal(meta)
		if err != nil {
			return err
		}
		return bucket.Put([]byte("meta"), raw)
	})
}

func filesBucket(mountID string) []byte {
	return append(append([]byte{}, filesBucketPrefix...), []byte(mountID)...)
}

func metaBucket(mountID string) []byte {
	return append(append([]byte{}, metaBucketPrefix...), []byte(mountID)...)
}
