import { useEffect } from 'react';
import { calendarsApi } from '../api';
import { useAsync } from './useAsync';

/** Keep mounted account and view selectors in sync with calendar creation. */
export function useCalendars() {
  const calendars = useAsync(calendarsApi.listCalendars);
  const { reload } = calendars;
  useEffect(() => calendarsApi.subscribeCalendarList(() => { void reload(); }), [reload]);
  return calendars;
}
