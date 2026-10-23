// F4 單選使用原生選單，鍵盤與焦點由瀏覽器管理，不繪製勾選標記。
import { useId } from 'react';
import type { CSSProperties } from 'react';
import { FONT_FAMILY, SELECT_TOKENS, useTheme } from '../../theme';
import { textStyle } from './textStyle';
export type SelectSize = keyof typeof SELECT_TOKENS.HEIGHT;
export interface SelectOption { readonly value: string; readonly label: string; }
export interface SelectProps {
  readonly prefix?: string;
  readonly options?: readonly SelectOption[];
  readonly value?: string;
  readonly placeholder?: string;
  readonly onChange?: (value: string) => void;
  readonly size?: SelectSize;
  readonly disabled?: boolean;
  readonly fullWidth?: boolean;
  readonly style?: CSSProperties;
  readonly label?: string;
}
export function Select({ prefix, options = [], value, placeholder = '請選擇', onChange, size = 'md', disabled = false, fullWidth = false, style, label }: SelectProps) {
  const { theme } = useTheme();
  const id = useId();
  const selected = options.some(option => option.value === value);
  return <label htmlFor={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0, maxWidth: '100%', width: fullWidth ? '100%' : undefined, ...style }}>
    {prefix && <span style={{ flexShrink: 0, color: theme.text.secondary, ...textStyle(SELECT_TOKENS.PREFIX_TEXT) }}>{prefix}</span>}
    <select id={id} aria-label={label ?? prefix ?? placeholder} value={selected ? value : ''} disabled={disabled}
      onChange={event => onChange?.(event.target.value)}
      style={{ minWidth: 0, maxWidth: '100%', flex: 1, minHeight: SELECT_TOKENS.HEIGHT[size], padding: '5px 10px', borderRadius: SELECT_TOKENS.RADIUS,
        border: `1px solid ${theme.border.input}`, background: theme.bg.surface, color: disabled ? theme.state.disabled.fg : theme.text.primary,
        fontFamily: FONT_FAMILY.base, ...textStyle(SELECT_TOKENS.TEXT[size]), cursor: disabled ? 'not-allowed' : 'pointer' }}>
      {!options.some(option => option.value === '') && <option value="" disabled>{placeholder}</option>}
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}
