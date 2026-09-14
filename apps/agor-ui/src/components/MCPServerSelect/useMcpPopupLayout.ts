import type { SelectProps } from 'antd';
import type { RefSelectProps } from 'antd/es/select';
import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react';

/** Keep the native, scrollable option list beside (never over) the attachment field. */
export function useMcpPopupLayout(
  props: Pick<SelectProps, 'open' | 'defaultOpen' | 'placement' | 'listHeight'>
) {
  const ref = useRef<RefSelectProps>(null);
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const [layout, setLayout] = useState<{
    placement: SelectProps['placement'];
    listHeight: number;
    style: CSSProperties;
  }>({
    placement: 'bottomLeft',
    listHeight: 256,
    style: {},
  });

  useLayoutEffect(() => {
    const field = ref.current?.nativeElement;
    if (!(props.open ?? open) || !field) return;
    const win = field.ownerDocument.defaultView!;
    const update = () => {
      const box = ref.current?.nativeElement?.getBoundingClientRect();
      if (!box) return;
      const viewport = win.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? win.innerHeight);
      // Reserve viewport breathing room and Select's popup padding. The list
      // itself scrolls when there isn't room for its normal 256px height.
      const above = Math.max(0, box.top - top - 16);
      const below = Math.max(0, bottom - box.bottom - 16);
      const placement = props.placement ?? (below >= above ? 'bottomLeft' : 'topLeft');
      const space = placement.startsWith('top') ? above : below;
      const listHeight = Math.max(1, Math.floor(Math.min(props.listHeight ?? 256, space)));
      const width = Math.min(box.width, viewport?.width ?? win.innerWidth);
      const left = Math.max(
        viewport?.offsetLeft ?? 0,
        Math.min(
          box.left,
          (viewport?.offsetLeft ?? 0) + (viewport?.width ?? win.innerWidth) - width
        )
      );
      const style: CSSProperties = {
        position: 'fixed',
        left,
        width,
        right: 'auto',
        top: placement.startsWith('top') ? 'auto' : box.bottom,
        bottom: placement.startsWith('top') ? win.innerHeight - box.top : 'auto',
      };
      setLayout((prev) =>
        prev.placement === placement &&
        prev.listHeight === listHeight &&
        prev.style.left === style.left &&
        prev.style.width === width &&
        prev.style.top === style.top &&
        prev.style.bottom === style.bottom
          ? prev
          : { placement, listHeight, style }
      );
    };
    // A body portal cannot follow a moving popover by DOM ancestry. Measure
    // while open, including transforms, nested scrolling, tag reflow and the
    // visual viewport (soft keyboard). Only changed geometry causes a render.
    let frame = 0;
    const follow = () => {
      update();
      frame = win.requestAnimationFrame(follow);
    };
    follow();
    return () => win.cancelAnimationFrame(frame);
  }, [open, props.open, props.placement, props.listHeight]);

  return { ref, setOpen, ...layout };
}
