import { describe, expect, it } from 'vitest';

import { foldWorkspaceIssueFields } from './workspaceIssueRow.js';

describe('foldWorkspaceIssueFields', () => {
  it('欄位皆有值：逐一摺出對應欄位', () => {
    const result = foldWorkspaceIssueFields({
      title: '標題',
      status: '處理中',
      assignee: '成員甲',
      point: 3,
      due: '2026-09-01',
      resolution: '已完成',
    });
    expect(result).toEqual({
      fields: { title: '標題', status: '處理中', assignee: '成員甲', point: 3, due: '2026-09-01', resolution: '已完成' },
      title: '標題',
      status: '處理中',
      assignee: '成員甲',
      point: 3,
      due: '2026-09-01',
      resolution: '已完成',
    });
  });

  it('欄位全缺：title/assignee 空字串，status 回退預設值，point/due/resolution 為 null', () => {
    const result = foldWorkspaceIssueFields({});
    expect(result).toEqual({
      fields: {},
      title: '',
      status: '待處理',
      assignee: '',
      point: null,
      due: null,
      resolution: null,
    });
  });

  it('status 為空字串：回退預設值，不是空字串本身', () => {
    const result = foldWorkspaceIssueFields({ status: '' });
    expect(result.status).toBe('待處理');
  });

  it('point 非數字型別：視為缺值，回 null', () => {
    const result = foldWorkspaceIssueFields({ point: '3' });
    expect(result.point).toBeNull();
  });

  it('due 為空字串：視為缺值，回 null', () => {
    const result = foldWorkspaceIssueFields({ due: '' });
    expect(result.due).toBeNull();
  });

  it('resolution 非字串型別：視為缺值，回 null', () => {
    const result = foldWorkspaceIssueFields({ resolution: 123 });
    expect(result.resolution).toBeNull();
  });
});
