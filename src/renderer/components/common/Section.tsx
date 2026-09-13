import {Spinner} from '@heroui/react';
import {isEmpty} from 'lodash-es';
import {Children, ElementType, Fragment, memo, ReactNode} from 'react';

import {useHMonitorState} from '../../state/hmonitorSlice';

type SectionProps = {
  title: string;
  icon: ElementType;
  children: ReactNode;
};

const Section = memo(({title, icon: Icon, children}: SectionProps) => {
  const displayStyle = useHMonitorState('displayStyle');
  const showSectionLabel = useHMonitorState('showSectionLabel');

  const isRaw = ['raw', 'raw-two-column'].includes(displayStyle);
  const isTwoColumn = ['two-column', 'raw-two-column'].includes(displayStyle);
  const isCompact = ['compact', 'two-column'].includes(displayStyle);
  const isSegmented = displayStyle === 'segmented';
  const isGhost = displayStyle === 'ghost';

  if (isGhost) {
    const validChildren = Children.toArray(children).filter(Boolean);
    if (!showSectionLabel && validChildren.length === 0) return null;

    return (
      <div
        className={
          'flex items-center shrink-0 hover:bg-surface-secondary/60 rounded-md px-1.5 py-0.5 ' +
          'gap-x-1.5 transition-colors duration-150 cursor-pointer'
        }>
        {showSectionLabel ? (
          <div className="flex items-center gap-x-1 shrink-0 text-foreground/80">
            <Icon className="size-3.5 shrink-0 text-foreground/70" />
            {isEmpty(title) ? (
              <Spinner size="sm" color="current" className="text-muted" />
            ) : (
              <span className="font-semibold text-foreground/90 uppercase text-[11px] tracking-wide whitespace-nowrap">
                {title}
              </span>
            )}
          </div>
        ) : (
          <Icon className="size-3.5 shrink-0 text-foreground/70" />
        )}
        {validChildren.map((child, i) => (
          <Fragment key={i}>
            <span className="text-foreground/30 select-none text-[10px]">•</span>
            {child}
          </Fragment>
        ))}
      </div>
    );
  }

  if (isSegmented) {
    const validChildren = Children.toArray(children).filter(Boolean);
    if (!showSectionLabel && validChildren.length === 0) return null;

    return (
      <div
        className={
          'flex items-center shrink-0 bg-surface-secondary/80 hover:bg-surface-secondary ' +
          'border border-surface-tertiary rounded-full px-2.5 py-1 gap-x-2 backdrop-blur-sm ' +
          'transition-colors duration-200'
        }>
        {showSectionLabel && (
          <div className="flex items-center gap-x-1.5 shrink-0">
            <Icon className="size-3.5 text-accent shrink-0" />
            {isEmpty(title) ? (
              <Spinner size="sm" color="current" className="text-muted" />
            ) : (
              <span className="text-xs font-semibold text-accent uppercase tracking-wider whitespace-nowrap">
                {title}
              </span>
            )}
          </div>
        )}
        {validChildren.map((child, i) => (
          <Fragment key={i}>
            {(showSectionLabel || i > 0) && <span className="w-px h-3 bg-foreground/15 shrink-0" />}
            {child}
          </Fragment>
        ))}
      </div>
    );
  }

  if (isRaw) {
    return (
      <div
        className={
          `flex items-center shrink-0 ${isTwoColumn ? 'gap-x-2' : 'gap-x-1.5'}` +
          ` text-xs font-mono whitespace-nowrap text-foreground leading-none`
        }>
        <span className="font-semibold text-foreground/80">{title}:</span>
        <div
          className={
            `${
              isTwoColumn
                ? 'grid grid-flow-col grid-rows-2 auto-cols-max gap-x-4 gap-y-1 h-10'
                : 'flex items-center gap-x-2 h-7'
            } shrink-0 ` +
            `${
              isTwoColumn &&
              `content-center items-start ${Children.count(children) > 1 ? 'justify-start' : 'justify-center'}`
            }`
          }>
          {Children.map(children, (child, i) => (
            <Fragment key={i}>
              {child}
              {!isTwoColumn && i < Children.count(children) - 1 && <span className="text-foreground/30">/</span>}
            </Fragment>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-center shrink-0 ${isTwoColumn ? 'gap-x-1.5' : isCompact ? 'gap-x-2' : 'gap-x-3'}`}>
      {showSectionLabel && (
        <div
          className={
            `flex items-center ${
              isTwoColumn ? 'h-10 gap-x-1.5 px-2' : isCompact ? 'gap-x-1.5 px-1.5 py-0.5' : 'gap-x-2 px-2 py-1'
            }` + ` rounded-md bg-surface border border-surface-secondary`
          }>
          <Icon className={`${isCompact ? 'size-3' : 'size-3.5'} text-foreground/70`} />
          {isEmpty(title) ? (
            <Spinner size="sm" color="current" className="text-muted" />
          ) : (
            <span
              className={
                `text-xs font-semibold text-foreground uppercase tracking-wide text-nowrap` +
                `${isTwoColumn ? ' max-w-38 truncate' : ''}`
              }>
              {title}
            </span>
          )}
        </div>
      )}
      <div
        className={
          isTwoColumn
            ? `grid grid-flow-col grid-rows-2 auto-cols-max gap-x-1 gap-y-0.5 h-10 content-center items-center shrink-0`
            : ' flex items-center gap-x-2 shrink-0'
        }>
        {children}
      </div>
    </div>
  );
});

export default Section;
