import { describe, expect, it } from 'vitest';
import {
  actorLabel,
  auditActionLabel,
  confidence,
  fileState,
  isRepairTerminal,
  issueResolution,
  issueStatus,
  issueType,
  jobMode,
  jobStatus,
  labelOf,
  machineStatus,
  mountState,
  repairStatus,
} from './labels';

describe('labelOf', () => {
  it('returns the mapped label and tone', () => {
    expect(labelOf(machineStatus, 'online')).toEqual({ label: '在线', tone: 'ok' });
    expect(labelOf(issueType, 'mismatch')).toEqual({ label: '内容不一致', tone: 'danger' });
    expect(labelOf(fileState, 'out_of_scope')).toEqual({ label: '已移出规则', tone: 'warn' });
  });

  it('falls back to the raw value and handles empty values', () => {
    expect(labelOf(machineStatus, 'weird')).toEqual({ label: 'weird', tone: 'neutral' });
    expect(labelOf(machineStatus, null)).toEqual({ label: '—', tone: 'neutral' });
  });
});

describe('status maps cover backend enums', () => {
  it('maps job, mount, issue and repair statuses', () => {
    for (const status of ['pending', 'running', 'completed', 'failed', 'canceled', 'expired']) {
      expect(labelOf(jobStatus, status).label).not.toBe(status);
    }
    for (const state of ['active', 'suspect', 'unavailable', 'removed']) {
      expect(labelOf(mountState, state).label).not.toBe(state);
    }
    for (const status of ['open', 'ignored', 'resolved']) {
      expect(labelOf(issueStatus, status).label).not.toBe(status);
    }
    for (const resolution of ['recovered', 'repaired', 'rebaselined']) {
      expect(labelOf(issueResolution, resolution).label).not.toBe(resolution);
    }
    for (const status of ['pending', 'transferring', 'ready', 'applying', 'completed', 'failed', 'canceled']) {
      expect(labelOf(repairStatus, status).label).not.toBe(status);
    }
    for (const mode of ['baseline', 'incremental', 'full']) {
      expect(labelOf(jobMode, mode).label).not.toBe(mode);
    }
    for (const level of ['high', 'medium', 'low']) {
      expect(labelOf(confidence, level).label).not.toBe(level);
    }
  });
});

describe('repair terminal', () => {
  it('treats completed/failed/canceled as terminal', () => {
    expect(isRepairTerminal('pending')).toBe(false);
    expect(isRepairTerminal('transferring')).toBe(false);
    expect(isRepairTerminal('ready')).toBe(false);
    expect(isRepairTerminal('applying')).toBe(false);
    expect(isRepairTerminal('completed')).toBe(true);
    expect(isRepairTerminal('failed')).toBe(true);
    expect(isRepairTerminal('canceled')).toBe(true);
  });
});

describe('audit labels', () => {
  it('translates known actions and keeps unknown ones', () => {
    expect(auditActionLabel('job.create')).toBe('创建巡检任务');
    expect(auditActionLabel('repair.complete')).toBe('修复完成');
    expect(auditActionLabel('mount.rebaseline')).toBe('确认删除并重建基线');
    expect(auditActionLabel('issue.rebaseline')).toBe('确认更新基线');
    expect(auditActionLabel('issue.ignore')).toBe('忽略异常');
    expect(auditActionLabel('unknown.action')).toBe('unknown.action');
    expect(auditActionLabel(null)).toBe('—');
  });

  it('labels actors', () => {
    expect(actorLabel('user')).toBe('用户');
    expect(actorLabel('system')).toBe('系统');
    expect(actorLabel('agent:7')).toBe('agent #7');
    expect(actorLabel(null)).toBe('—');
  });
});
