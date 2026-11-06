import { describe, expect, it } from "vitest";
import {
  confidence,
  connectionState,
  fileState,
  hashKind,
  issueStatus,
  issueType,
  jobMode,
  jobStatus,
  labelOf,
  machineStatus,
  mountState,
  observationKind,
  statLabel,
} from "./labels.js";

describe("labelOf", () => {
  it("returns mapped labels and tones", () => {
    expect(labelOf(machineStatus, "online")).toEqual({ label: "在线", tone: "ok" });
    expect(labelOf(jobStatus, "failed")).toEqual({ label: "失败", tone: "danger" });
    expect(labelOf(issueType, "mismatch")).toEqual({ label: "内容不一致", tone: "danger" });
  });

  it("falls back for unknown and empty values", () => {
    expect(labelOf(jobStatus, "weird")).toEqual({ label: "weird", tone: "neutral" });
    expect(labelOf(jobStatus, null)).toEqual({ label: "—", tone: "neutral" });
  });
});

describe("backend enum coverage", () => {
  it("maps all job/mount/issue/file statuses to Chinese", () => {
    for (const value of ["pending", "running", "completed", "failed", "canceled", "expired"]) {
      expect(labelOf(jobStatus, value).label).not.toBe(value);
    }
    for (const value of ["active", "suspect", "unavailable", "removed"]) {
      expect(labelOf(mountState, value).label).not.toBe(value);
    }
    for (const value of ["open", "acked", "ignored", "resolved"]) {
      expect(labelOf(issueStatus, value).label).not.toBe(value);
    }
    for (const value of ["active", "missing", "out_of_scope"]) {
      expect(labelOf(fileState, value).label).not.toBe(value);
    }
    for (const value of ["high", "medium", "low"]) {
      expect(labelOf(confidence, value).label).not.toBe(value);
    }
    for (const value of ["scan", "repair"]) {
      expect(labelOf(observationKind, value).label).not.toBe(value);
    }
    for (const value of ["hash", "skip"]) {
      expect(labelOf(hashKind, value).label).not.toBe(value);
    }
    for (const value of ["baseline", "incremental", "full"]) {
      expect(labelOf(jobMode, value).label).not.toBe(value);
    }
  });

  it("exposes connection states", () => {
    expect(connectionState.connected.label).toBe("已连接");
    expect(connectionState.disconnected.tone).toBe("danger");
  });
});

describe("statLabel", () => {
  it("translates known stats and keeps unknown keys", () => {
    expect(statLabel("seen")).toBe("发现文件");
    expect(statLabel("bytes_read")).toBe("读取字节");
    expect(statLabel("duration_ms")).toBe("耗时");
    expect(statLabel("custom")).toBe("custom");
  });
});
