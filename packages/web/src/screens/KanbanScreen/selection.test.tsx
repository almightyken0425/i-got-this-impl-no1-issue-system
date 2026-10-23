import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ThemeProvider } from '../../theme';
import { KanbanResolutionPrompt } from './internal';

test('結案原因保留必填與取消操作，以選單取代單選框', () => {
  const html = renderToStaticMarkup(<ThemeProvider><KanbanResolutionPrompt
    issue={{ key: 'DEV-7' }} targetLabel="已完成"
    options={[{ value: '完成' }, { value: '取消' }]}
    onCancel={() => {}} onConfirm={() => {}}
  /></ThemeProvider>);
  expect(html).not.toMatch(/role="radio"|type="radio"|type="checkbox"/);
  expect(html).toContain('選擇結案原因');
  expect(html).toContain('取消');
  expect(html).toMatch(/<button[^>]*disabled/);
});
