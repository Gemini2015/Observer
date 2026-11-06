import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodePath,
  formatBytes,
  formatCount,
  formatDuration,
  formatNs,
  formatRelative,
  formatStatValue,
  formatTime,
  joinPath,
  shortHash,
} from "./format.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T04:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatBytes", () => {
  it("uses binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
    expect(formatBytes(null)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  it("formats ranges", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(500)).toBe("500 ms");
    expect(formatDuration(1500)).toBe("1.5 秒");
    expect(formatDuration(65_000)).toBe("1 分 5 秒");
    expect(formatDuration(3_600_000)).toBe("1 小时 0 分");
    expect(formatDuration(undefined)).toBe("—");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-11-06T04:00:00Z").getTime();

  it("switches units by distance", () => {
    expect(formatRelative(now - 30_000)).toBe("刚刚");
    expect(formatRelative(now - 5 * 60_000)).toBe("5 分钟前");
    expect(formatRelative(now - 3 * 3_600_000)).toBe("3 小时前");
    expect(formatRelative(now - 2 * 86_400_000)).toBe("2 天前");
  });

  it("falls back to absolute time beyond 30 days", () => {
    expect(formatRelative(now - 40 * 86_400_000)).toBe(formatTime(now - 40 * 86_400_000));
  });
});

describe("joinPath", () => {
  it("joins Windows mounts with backslashes", () => {
    expect(joinPath("windows", "E:\\LX77\\Content", "UI/a.png")).toBe(
      "E:\\LX77\\Content\\UI\\a.png",
    );
  });

  it("joins macOS mounts with forward slashes", () => {
    expect(joinPath("darwin", "/Volumes/Data", "UI/a.png")).toBe("/Volumes/Data/UI/a.png");
  });

  it("infers Windows style from UNC/drive paths when platform is unknown", () => {
    expect(joinPath(null, "\\\\nas\\share", "a/b.txt")).toBe("\\\\nas\\share\\a\\b.txt");
    expect(joinPath(null, "/mnt/data", "a/b.txt")).toBe("/mnt/data/a/b.txt");
  });

  it("returns the relative path when root is empty", () => {
    expect(joinPath("windows", "", "a/b.txt")).toBe("a/b.txt");
  });
});

describe("formatTime / formatNs", () => {
  it("formats absolute time", () => {
    expect(formatTime(0)).toBe("-");
    expect(formatTime(1_700_000_000_000)).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("formats nanosecond strings without precision loss", () => {
    expect(formatNs("1700000000123456789")).toBe(formatTime(1_700_000_000_123));
    expect(formatNs("bad")).toBe("bad");
    expect(formatNs(null)).toBe("-");
  });
});

describe("misc formatting", () => {
  it("formats counts, hashes and stats", () => {
    expect(formatCount(12345)).toBe("12,345");
    expect(shortHash("a".repeat(64))).toBe(`${'a'.repeat(12)}…`);
    expect(formatStatValue("bytes_read", 2048)).toBe("2.0 KiB");
    expect(formatStatValue("duration_ms", 1500)).toBe("1.5 秒");
    expect(formatStatValue("seen", 12345)).toBe("12,345");
  });

  it("decodes base64 paths", () => {
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode("目录/a.txt")));
    expect(decodePath(encoded)).toBe("目录/a.txt");
    expect(decodePath("!!!")).toBe("!!!");
  });
});
