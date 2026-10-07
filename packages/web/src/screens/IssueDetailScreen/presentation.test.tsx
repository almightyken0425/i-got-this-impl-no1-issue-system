import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ThemeProvider } from '../../theme';
import { EditableTextField } from './internal';

test('欄位預設為可鍵盤啟動的閱讀態，沒有常駐輸入框', () => {
  const html = renderToStaticMarkup(<ThemeProvider><EditableTextField value="修好跨月結轉" onCommit={() => {}} /></ThemeProvider>);
  expect(html).toContain('修好跨月結轉');
  expect(html).toContain('<button');
  expect(html).not.toContain('<input');
});

test('空欄位提供填寫入口，仍可看懂缺少內容', () => {
  const html = renderToStaticMarkup(<ThemeProvider><EditableTextField value="" onCommit={() => {}} /></ThemeProvider>);
  expect(html).toContain('未填寫');
  expect(html).toContain('<button');
});
