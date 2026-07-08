import { Typography } from 'antd';
import type React from 'react';
import { useHref, useNavigate } from 'react-router-dom';
import type { LinkDisplayItem } from './linkDisplay';

interface LinkDisplayTargetLinkProps {
  item: LinkDisplayItem;
  children: React.ReactNode;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
}

function isPlainLeftClick(event: React.MouseEvent<HTMLElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

const SpaLink: React.FC<LinkDisplayTargetLinkProps & { href: string }> = ({
  item,
  href,
  children,
  onClick,
}) => {
  const routedHref = useHref(href);
  const navigate = useNavigate();

  return (
    <Typography.Link
      href={routedHref}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !isPlainLeftClick(event)) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </Typography.Link>
  );
};

export const LinkDisplayTargetLink: React.FC<LinkDisplayTargetLinkProps> = ({
  item,
  children,
  onClick,
}) => {
  if (!item.href) return <>{children}</>;

  if (item.navigation === 'spa') {
    return (
      <SpaLink item={item} href={item.href} onClick={onClick}>
        {children}
      </SpaLink>
    );
  }

  return (
    <Typography.Link href={item.href} target="_blank" rel="noopener noreferrer" onClick={onClick}>
      {children}
    </Typography.Link>
  );
};

export default LinkDisplayTargetLink;
