// KanbanCard · 看板卡
//
// 來源：design git 的 `20_components/no2_data_display.jsx`（KanbanCard 段）。
//
// 拖曳態：抬起走 level3 陰影加微幅放大傾斜，原位殘影走 ghost。
// 載入態：狀態轉換進行中，壓暗加 spinner，期間不可再拖。
//
// 拖曳與載入都是外部餵進來的旗標，卡片自己不記——一次拖曳橫跨兩個欄，
// 狀態只能由看板畫面持有。

import { useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';

import {
  F4_LAYOUT,
  DATA_DISPLAY_COLORS,
  DATA_DISPLAY_TOKENS,
  FONT_FAMILY,
  NUMERIC_FONT_VARIANT,
  RADIUS,
  SPACING,
  TYPOGRAPHY,
  useTheme,
} from '../../theme';
import {
  AvatarSlot,
  BadgeSlot,
  Glyph,
  SPIN_ANIMATION_NAME,
  Truncate,
  elevationShadow,
  focusStyleCss,
  typeStyleCss,
  useSpinKeyframes,
} from './internal';
import { toDateValue, toStatusValue, toUserValue } from './types';
import { F4Icon } from '../controls/F4Icon';

const K = DATA_DISPLAY_TOKENS.KANBAN;

export interface KanbanCardProps {
  readonly issueKey: string;
  readonly id?: string;
  readonly title: string;
  /** 字串即姓名；物件讀 name。省略則不畫負責人。 */
  readonly assignee?: unknown;
  /** 字串即 label；物件另帶 tone 決定 badge 配色。 */
  readonly status?: unknown;
  /** 字串即 label；物件另帶 overdue 或 soon 決定到期色。 */
  readonly due?: unknown;
  /** 這張卡正被拖起。 */
  readonly dragging?: boolean | undefined;
  /** 這張卡是拖曳來源的原位殘影。 */
  readonly ghost?: boolean | undefined;
  /** 狀態轉換進行中，壓暗並顯示 spinner，期間不可互動。 */
  readonly loading?: boolean | undefined;
  readonly selected?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly draggable?: boolean | undefined;
  readonly onClick?: ((event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => void) | undefined;
  readonly onDragStart?: ((event: DragEvent<HTMLElement>) => void) | undefined;
  readonly onDragEnd?: ((event: DragEvent<HTMLElement>) => void) | undefined;
}

export function KanbanCard({
  issueKey,
  id,
  title,
  assignee,
  status,
  due,
  dragging = false,
  ghost = false,
  loading = false,
  selected = false,
  disabled = false,
  draggable = true,
  onClick,
  onDragStart,
  onDragEnd,
}: KanbanCardProps) {
  const { theme } = useTheme();
  const c = DATA_DISPLAY_COLORS.KANBAN(theme);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  useSpinKeyframes();

  const interactive = !disabled && !loading;
  const statusValue = toStatusValue(status);
  const assigneeValue = toUserValue(assignee);
  const dueValue = toDateValue(due);

  const borderColor =
    selected || dragging ? c.cardSelectedBorder : hover && interactive ? c.cardHoverBorder : c.cardBorder;
  const dueFg =
    dueValue?.tone === 'overdue' ? c.overdueFg : dueValue?.tone === 'soon' ? c.dueSoonFg : c.cardMetaFg;
  const metaFg = disabled ? c.disabledFg : dueFg;
  const opacity = ghost
    ? K.CARD_GHOST_OPACITY
    : loading
      ? K.CARD_LOADING_OPACITY
      : disabled
        ? c.disabledOpacity
        : 1;

  return (
    <article
      id={id}
      role="button"
      aria-label={`${issueKey} ${title}`}
      className="f4-issue-card"
      draggable={draggable && interactive}
      tabIndex={interactive ? 0 : -1}
      aria-disabled={disabled || undefined}
      aria-busy={loading || undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onClick={interactive ? onClick : undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onKeyDown={(event) => {
        if (!interactive) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick?.(event);
        }
      }}
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: `${F4_LAYOUT.thumbnailWidth}px minmax(0, 1fr)`,
        columnGap: SPACING.md,
        minHeight: F4_LAYOUT.cardMinHeight,
        boxSizing: 'border-box',
        alignItems: 'center',
        padding: `${K.CARD_PADDING_Y}px ${K.CARD_PADDING_X}px`,
        background: c.cardBg,
        border: `${K.CARD_BORDER_WIDTH}px solid ${borderColor}`,
        borderRadius: K.CARD_RADIUS,
        boxShadow: elevationShadow(c.shadowColor, dragging ? K.CARD_DRAG_ELEVATION : K.CARD_ELEVATION),
        transform: dragging ? `scale(${K.CARD_DRAG_SCALE}) rotate(${K.CARD_DRAG_TILT})` : 'none',
        opacity,
        color: disabled ? c.disabledFg : c.cardTitleFg,
        cursor: !interactive ? 'default' : dragging ? 'grabbing' : draggable ? 'grab' : 'pointer',
        transition: `box-shadow ${K.TRANSITION_MS}ms ${K.TRANSITION_EASING}, border-color ${K.TRANSITION_MS}ms ${K.TRANSITION_EASING}, transform ${K.TRANSITION_MS}ms ${K.TRANSITION_EASING}`,
        fontFamily: FONT_FAMILY.base,
        ...(focus ? focusStyleCss(c, K.CARD_FOCUS_RING_WIDTH, K.CARD_FOCUS_RING_OFFSET) : null),
      }}
    >
      <div aria-hidden="true" className="f4-card-glyph" style={{ alignSelf: 'stretch', display: 'grid', placeItems: 'center', minHeight: F4_LAYOUT.thumbnailHeight, borderRadius: F4_LAYOUT.thumbnailRadius, color: theme.primary.main, background: theme.state.selected.bg }}>
        <F4Icon name="issue" size={38} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: K.CARD_ROW_GAP, minWidth: 0 }}>
      {/* 編號與狀態 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.xs, minWidth: 0 }}>
        <span
          style={{
            fontFamily: FONT_FAMILY.mono,
            fontVariantNumeric: NUMERIC_FONT_VARIANT,
            color: disabled ? c.disabledFg : c.cardKeyFg,
            flexShrink: 0,
            ...typeStyleCss(K.CARD_KEY_TYPE, { fontWeight: TYPOGRAPHY.weight.medium }),
          }}
        >
          {issueKey}
        </span>
        {statusValue !== null && (
          <span style={{ marginLeft: 'auto', minWidth: 0 }}>
            <BadgeSlot
              theme={theme}
              label={statusValue.label}
              tone={statusValue.tone}
              geometry={{
                height: K.CARD_BADGE_HEIGHT,
                radius: K.CARD_BADGE_RADIUS,
                paddingX: K.CARD_BADGE_PADDING_X,
                typeStyle: K.CARD_BADGE_TYPE,
                dot: K.CARD_BADGE_DOT,
              }}
              neutralBg={c.neutralBadgeBg}
              neutralFg={c.neutralBadgeFg}
            />
          </span>
        )}
      </div>

      {/* 標題，最多兩行 */}
      <div
        title={title}
        style={{
          display: '-webkit-box',
          WebkitLineClamp: K.CARD_TITLE_MAX_LINES,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          color: disabled ? c.disabledFg : c.cardTitleFg,
          ...typeStyleCss(K.CARD_TITLE_TYPE),
        }}
      >
        {title}
      </div>

      {/* 負責人與到期 */}
      {(assigneeValue !== null || dueValue !== null || loading) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: SPACING.xs,
            minWidth: 0,
            ...typeStyleCss(K.CARD_META_TYPE),
          }}
        >
          {assigneeValue !== null && (
            <>
              <AvatarSlot
                name={assigneeValue.name}
                size={K.CARD_AVATAR_SIZE}
                bg={c.avatarBg}
                fg={c.avatarFg}
                typeStyle={K.CARD_META_TYPE}
              />
              <Truncate title={assigneeValue.name}>
                <span style={{ color: disabled ? c.disabledFg : c.cardMetaFg }}>{assigneeValue.name}</span>
              </Truncate>
            </>
          )}
          {dueValue !== null && (
            <span
              style={{
                marginLeft: 'auto',
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                gap: SPACING['2xs'],
                color: metaFg,
                fontVariantNumeric: NUMERIC_FONT_VARIANT,
              }}
            >
              <Glyph name="clock" size={K.CARD_META_ICON_SIZE} color={metaFg} />
              {dueValue.label}
            </span>
          )}
          {loading && (
            <span
              style={{
                marginLeft: assigneeValue !== null || dueValue !== null ? SPACING.xs : 'auto',
                flexShrink: 0,
                width: K.CARD_SPINNER_SIZE,
                height: K.CARD_SPINNER_SIZE,
                borderRadius: RADIUS.full,
                border: `${K.CARD_SPINNER_TRACK_WIDTH}px solid ${c.spinnerTrack}`,
                borderTopColor: c.spinnerHead,
                animation: `${SPIN_ANIMATION_NAME} ${K.CARD_SPINNER_DURATION_MS}ms linear infinite`,
              }}
            />
          )}
        </div>
      )}
      </div>
    </article>
  );
}
