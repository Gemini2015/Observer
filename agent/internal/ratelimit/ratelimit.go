// Package ratelimit 实现 credit bucket：额度按速率补充、有上限、可为负（欠账）。
package ratelimit

import (
	"context"
	"math"
	"sync"
	"time"
)

// Limiter 是单维度限速器（文件数或字节数）。
type Limiter struct {
	rate  float64
	burst float64
	credit float64

	mu   sync.Mutex
	last time.Time
	now  func() time.Time
}

// New 创建限速器。ratePerSec <= 0 表示不限速。
func New(ratePerSec, burst float64) *Limiter {
	limiter := &Limiter{
		rate:   ratePerSec,
		burst:  math.Max(burst, 0),
		credit: math.Max(burst, 0),
		last:   time.Now(),
		now:    time.Now,
	}
	return limiter
}

// SetClock 仅用于测试。
func (l *Limiter) SetClock(now func() time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.now = now
	l.last = now()
}

// WaitFor 等待到可处理 work 个单位。
// 规则：等到 credit >= min(need, burst) 后，credit -= need（允许变负 = 欠账）。
// 因此单个文件读完后才会产生欠账，后续文件通过等待偿还。
func (l *Limiter) WaitFor(ctx context.Context, need float64) error {
	if l.rate <= 0 || need <= 0 {
		return nil
	}
	target := math.Min(need, l.burst)
	if target <= 0 {
		return nil
	}

	for {
		l.mu.Lock()
		l.refillLocked()
		if l.credit >= target {
			l.credit -= need
			l.mu.Unlock()
			return nil
		}
		deficit := target - l.credit
		l.mu.Unlock()

		seconds := deficit / l.rate
		wait := time.Duration(seconds * float64(time.Second))
		if wait < time.Millisecond {
			wait = time.Millisecond
		}

		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// Credit 返回当前额度（调试/测试用）。
func (l *Limiter) Credit() float64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.refillLocked()
	return l.credit
}

func (l *Limiter) refillLocked() {
	now := l.now()
	elapsed := now.Sub(l.last).Seconds()
	if elapsed <= 0 {
		return
	}
	l.credit += elapsed * l.rate
	if l.credit > l.burst {
		l.credit = l.burst
	}
	l.last = now
}
