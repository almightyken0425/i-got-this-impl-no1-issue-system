// 日曆 API：選用、週規則與日期例外維護。

import { apiFetch } from './client';
import type { WorkCalendar } from './types';

const listListeners = new Set<() => void>();

/** Already-mounted selectors refresh only after a new calendar is saved. */
export function subscribeCalendarList(listener: () => void): () => void {
  listListeners.add(listener);
  return () => { listListeners.delete(listener); };
}

export async function listCalendars(): Promise<readonly WorkCalendar[]> {
  const res = await apiFetch<{ calendars: readonly WorkCalendar[] }>('/api/calendars');
  return res.calendars;
}

export async function createCalendar(name: string, weeklyOff: readonly string[]): Promise<WorkCalendar> {
  const { calendar } = await apiFetch<{ calendar: WorkCalendar }>('/api/calendars', { method: 'POST', body: { name, weeklyOff } });
  for (const listener of listListeners) listener();
  return calendar;
}
export function updateWeeklyOff(name: string, weeklyOff: readonly string[]): Promise<unknown> {
  return apiFetch(`/api/calendars/${encodeURIComponent(name)}/weekly-off`, { method: 'PUT', body: { weeklyOff } });
}
export function setCalendarException(name: string, date: string, isWorking: boolean): Promise<unknown> {
  return apiFetch(`/api/calendars/${encodeURIComponent(name)}/exceptions/${date}`, { method: 'PUT', body: { isWorking } });
}
export function removeCalendarException(name: string, date: string): Promise<void> {
  return apiFetch(`/api/calendars/${encodeURIComponent(name)}/exceptions/${date}`, { method: 'DELETE' });
}
