import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatNs,
  formatPercent,
  formatRelative,
  formatStatValue,
  formatTime,
  joinMountPath,
  shortHash,
} from './format';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('formatBytes', () => {
  it('handles zero and negative values', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
  });

  it('uses binary units with one decimal above bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TiB');
  });
});

describe('formatDuration', () => {
  it('formats ranges', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(500)).toBe('500 ms');
    expect(formatDuration(1500)).toBe('1.5 秒');
    expect(formatDuration(65_000)).toBe('1 分 5 秒');
    expect(formatDuration(3_600_000)).toBe('1 小时 0 分');
  });

  it('returns dash for missing values', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('formats ratios', () => {
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(0.735)).toBe('73.5%');
    expect(formatPercent(1)).toBe('100.0%');
    expect(formatPercent(null)).toBe('—');
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-11-05T12:00:00Z').getTime();

  it('switches units by distance', () => {
    expect(formatRelative(now - 30_000)).toBe('刚刚');
    expect(formatRelative(now - 5 * 60_000)).toBe('5 分钟前');
    expect(formatRelative(now - 3 * 3_600_000)).toBe('3 小时前');
    expect(formatRelative(now - 2 * 86_400_000)).toBe('2 天前');
  });

  it('falls back to absolute time beyond 30 days', () => {
    expect(formatRelative(now - 40 * 86_400_000)).toBe(formatTime(now - 40 * 86_400_000));
  });

  it('returns dash for missing timestamps', () => {
    expect(formatRelative(null)).toBe('-');
  });
});

describe('joinMountPath', () => {
  it('joins windows mounts with backslashes', () => {
    expect(joinMountPath('windows', 'D:\\Media', 'photos/2024/a.jpg')).toBe(
      'D:\\Media\\photos\\2024\\a.jpg',
    );
    expect(joinMountPath('win32', 'D:\\Media\\', 'a/b.txt')).toBe('D:\\Media\\a\\b.txt');
  });

  it('joins posix mounts with forward slashes', () => {
    expect(joinMountPath('linux', '/srv/data', 'photos/a.jpg')).toBe('/srv/data/photos/a.jpg');
    expect(joinMountPath('darwin', '/Volumes/Media/', 'a/b.txt')).toBe('/Volumes/Media/a/b.txt');
  });

  it('infers windows style from UNC paths when platform is unknown', () => {
    expect(joinMountPath(null, '\\\\nas\\share', 'a/b.txt')).toBe('\\\\nas\\share\\a\\b.txt');
    expect(joinMountPath(null, '/mnt/data', 'a/b.txt')).toBe('/mnt/data/a/b.txt');
  });

  it('returns the relative path when the mount root is empty', () => {
    expect(joinMountPath('linux', '', 'a/b.txt')).toBe('a/b.txt');
  });
});

describe('formatTime / formatNs', () => {
  it('formats absolute time consistently', () => {
    expect(formatTime(0)).toBe('-');
    expect(formatTime(null)).toBe('-');
    expect(formatTime(1_700_000_000_000)).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('converts nanosecond strings without precision loss', () => {
    expect(formatNs('1700000000123456789')).toBe(formatTime(1_700_000_000_123));
    expect(formatNs('not-a-number')).toBe('not-a-number');
    expect(formatNs(null)).toBe('-');
  });
});

describe('formatCount / shortHash / formatStatValue', () => {
  it('formats counts with thousand separators', () => {
    expect(formatCount(12345)).toBe('12,345');
    expect(formatCount(null)).toBe('0');
  });

  it('shortens hashes', () => {
    expect(shortHash(null)).toBe('-');
    expect(shortHash('abc')).toBe('abc');
    expect(shortHash('a'.repeat(64))).toBe(`${'a'.repeat(12)}…`);
  });

  it('formats stats by key semantics', () => {
    expect(formatStatValue('bytes_read', 2048)).toBe('2.0 KiB');
    expect(formatStatValue('duration_ms', 1500)).toBe('1.5 秒');
    expect(formatStatValue('seen', 12345)).toBe('12,345');
    expect(formatStatValue('guarded', true)).toBe('是');
    expect(formatStatValue('reason', 'ok')).toBe('ok');
  });
});
